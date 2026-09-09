import type { ImageContent, TextContent, Usage } from "@earendil-works/pi-ai"
import {
  buildInspectorPrompt,
  coalesceMutationDeltas,
  selectApplicableInstructions,
  type InspectionContextRequest,
  type InspectionFinding,
  type LoadedContextFile,
  type MutationDelta,
} from "./core.ts"
import {
  shouldRunLuna,
  type DeterministicCheckOutcome,
  type DeterministicFinding,
  type DeterministicSkip,
} from "./deterministic.ts"
import type {
  InspectorProcessOutcome,
  NestedModelUsage,
} from "./inspector-process.ts"

export type CombinedInspectionFinding = DeterministicFinding | InspectionFinding

export type InspectionRunResult =
  | {
      readonly status: "findings"
      readonly findings: readonly CombinedInspectionFinding[]
      readonly contextRequests: readonly InspectionContextRequest[]
      readonly skipped: readonly DeterministicSkip[]
      readonly usage?: NestedModelUsage
    }
  | {
      readonly status: "clean"
      readonly skipped: readonly DeterministicSkip[]
      readonly usage?: NestedModelUsage
    }
  | {
      readonly status: "skipped"
      readonly reason:
        | "batch-limit"
        | "cancelled"
        | "deterministic-unavailable"
        | "model-timeout"
        | "model-unavailable"
        | "malformed-model-output"
      readonly skipped: readonly DeterministicSkip[]
      readonly usage?: NestedModelUsage
    }

export interface InspectionRunDependencies {
  readonly cwd: string
  readonly signal: AbortSignal | undefined
  readonly contextFiles: readonly LoadedContextFile[]
  readonly deterministic: (
    files: Parameters<typeof shouldRunLuna>[1],
  ) => Promise<DeterministicCheckOutcome>
  readonly luna: (
    prompt: string,
    files: Parameters<typeof shouldRunLuna>[1],
  ) => Promise<InspectorProcessOutcome>
}

type ToolResultContent = TextContent | ImageContent

export interface InspectionPatchInput {
  readonly content: readonly ToolResultContent[]
  readonly details: unknown
  readonly usage: Usage | undefined
}

export interface InspectionResultPatch {
  readonly content: ToolResultContent[]
  readonly details: Record<string, unknown> & {
    readonly writeResultInspection: InspectionRunResult
  }
  readonly usage?: Usage
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

export const runInspectionBatch = async (
  deltas: readonly MutationDelta[],
  dependencies: InspectionRunDependencies,
): Promise<InspectionRunResult> => {
  const batch = coalesceMutationDeltas(deltas)
  if (batch.status !== "ready")
    return { status: "skipped", reason: "batch-limit", skipped: [] }
  if (dependencies.signal?.aborted)
    return { status: "skipped", reason: "cancelled", skipped: [] }

  const deterministic = await dependencies.deterministic(batch.files)
  if (deterministic.status === "cancelled")
    return { status: "skipped", reason: "cancelled", skipped: [] }
  if (deterministic.status === "findings")
    return {
      status: "findings",
      findings: deterministic.findings,
      contextRequests: [],
      skipped: deterministic.skipped,
    }
  if (!shouldRunLuna(deterministic, batch.files)) {
    if (deterministic.skipped.length > 0)
      return {
        status: "skipped",
        reason: "deterministic-unavailable",
        skipped: deterministic.skipped,
      }
    return { status: "clean", skipped: [] }
  }
  if (dependencies.signal?.aborted)
    return { status: "skipped", reason: "cancelled", skipped: [] }

  const instructions = selectApplicableInstructions(
    batch.files,
    dependencies.contextFiles,
    dependencies.cwd,
  )
  const luna = await dependencies.luna(
    buildInspectorPrompt(batch.files, instructions),
    batch.files,
  )
  if (luna.status === "skipped") {
    const reason =
      luna.reason === "cancelled"
        ? "cancelled"
        : luna.reason === "timeout"
          ? "model-timeout"
          : "model-unavailable"
    return {
      status: "skipped",
      reason,
      skipped: [],
      ...(luna.usage ? { usage: luna.usage } : {}),
    }
  }
  if (luna.status === "invalid")
    return {
      status: "skipped",
      reason: "malformed-model-output",
      skipped: [],
      ...(luna.usage ? { usage: luna.usage } : {}),
    }
  if (luna.findings.length > 0 || luna.contextRequests.length > 0)
    return {
      status: "findings",
      findings: luna.findings,
      contextRequests: luna.contextRequests,
      skipped: [],
      usage: luna.usage,
    }
  return { status: "clean", skipped: [], usage: luna.usage }
}

const usageValue = (
  usage: Usage | NestedModelUsage | undefined,
  field: "input" | "output" | "cacheRead" | "cacheWrite" | "totalTokens",
): number => usage?.[field] ?? 0

const costValue = (
  usage: Usage | NestedModelUsage | undefined,
  field: "input" | "output" | "cacheRead" | "cacheWrite" | "total",
): number => usage?.cost[field] ?? 0

export const mergeNestedUsage = (
  left: Usage | NestedModelUsage | undefined,
  right: Usage | NestedModelUsage | undefined,
): Usage | undefined => {
  if (!left && !right) return undefined
  const cacheWrite1h = (left?.cacheWrite1h ?? 0) + (right?.cacheWrite1h ?? 0)
  const reasoning = (left?.reasoning ?? 0) + (right?.reasoning ?? 0)
  return {
    input: usageValue(left, "input") + usageValue(right, "input"),
    output: usageValue(left, "output") + usageValue(right, "output"),
    cacheRead: usageValue(left, "cacheRead") + usageValue(right, "cacheRead"),
    cacheWrite:
      usageValue(left, "cacheWrite") + usageValue(right, "cacheWrite"),
    ...(left?.cacheWrite1h === undefined && right?.cacheWrite1h === undefined
      ? {}
      : { cacheWrite1h }),
    ...(left?.reasoning === undefined && right?.reasoning === undefined
      ? {}
      : { reasoning }),
    totalTokens:
      usageValue(left, "totalTokens") + usageValue(right, "totalTokens"),
    cost: {
      input: costValue(left, "input") + costValue(right, "input"),
      output: costValue(left, "output") + costValue(right, "output"),
      cacheRead: costValue(left, "cacheRead") + costValue(right, "cacheRead"),
      cacheWrite:
        costValue(left, "cacheWrite") + costValue(right, "cacheWrite"),
      total: costValue(left, "total") + costValue(right, "total"),
    },
  }
}

const findingLine = (finding: CombinedInspectionFinding): string => {
  const severity = finding.severity.toUpperCase()
  const location =
    "deltaLine" in finding && finding.deltaLine !== undefined
      ? `:${finding.deltaLine}`
      : ""
  return `${severity} ${finding.path}${location} [${finding.inspector}/${finding.code}] ${finding.message}`
}

const contextRequestLine = (request: InspectionContextRequest): string =>
  `CONTEXT ${request.path} [${request.judgment}] ${request.reason} · ${request.symbols.join(", ")}`

const advisoryText = (result: InspectionRunResult): string => {
  const header = "Micro-inspection · advisory only; grants no authority"
  if (result.status === "clean")
    return `${header}\nCLEAN · local checks found no issue`
  if (result.status === "skipped")
    return `${header}\nSKIPPED · ${result.reason}`
  return [
    header,
    ...result.findings.map(findingLine),
    ...result.contextRequests.map(contextRequestLine),
  ].join("\n")
}

export const inspectionResultPatch = (
  input: InspectionPatchInput,
  result: InspectionRunResult,
): InspectionResultPatch => {
  const existingDetails = isRecord(input.details)
    ? input.details
    : input.details === undefined
      ? {}
      : { originalDetails: input.details }
  const usage = mergeNestedUsage(input.usage, result.usage)
  return {
    content: [...input.content, { type: "text", text: advisoryText(result) }],
    details: { ...existingDetails, writeResultInspection: result },
    ...(usage ? { usage } : {}),
  }
}
