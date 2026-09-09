import { Effect } from "effect"
import {
  WorkflowScriptError,
  type AgentRequest,
  type WorkflowLimits,
} from "./core.ts"

export const WORKFLOW_RUNTIME_ENTRY = "classified-workflows.runtime"
export const MAX_WORKFLOW_RECOVERIES = 3

export type PersistedWorkflowStatus =
  "running" | "completed" | "failed" | "cancelled"

export interface PersistedWorkflowRun {
  readonly id: string
  readonly label: string
  readonly code: string
  readonly limits: WorkflowLimits
  readonly startedAt: number
  readonly updatedAt: number
  readonly status: PersistedWorkflowStatus
  readonly recoveryCount: number
}

export interface WorkflowRuntimeState {
  readonly runs: readonly PersistedWorkflowRun[]
}

export const emptyWorkflowRuntimeState: WorkflowRuntimeState = { runs: [] }

const MAX_RETAINED_WORKFLOW_RUNS = 50
const READ_ONLY_RECOVERY_TOOLS = new Set(["read", "grep", "find", "ls"])

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const hasOnlyKeys = (
  value: Readonly<Record<string, unknown>>,
  keys: readonly string[],
): boolean => Object.keys(value).every(key => keys.includes(key))

const isIntegerBetween = (
  value: unknown,
  minimum: number,
  maximum: number,
): value is number =>
  Number.isSafeInteger(value) &&
  Number(value) >= minimum &&
  Number(value) <= maximum

const decodeLimits = (value: unknown): WorkflowLimits | undefined => {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      "maxAgents",
      "concurrency",
      "agentTimeoutMs",
      "workflowTimeoutMs",
      "retries",
      "tokenBudget",
    ]) ||
    !isIntegerBetween(value.maxAgents, 1, 16) ||
    !isIntegerBetween(value.concurrency, 1, 8) ||
    value.concurrency > value.maxAgents ||
    !isIntegerBetween(value.agentTimeoutMs, 180_000, 900_000) ||
    !isIntegerBetween(value.workflowTimeoutMs, 1_000, 3_600_000) ||
    !isIntegerBetween(value.retries, 0, 3) ||
    !isIntegerBetween(value.tokenBudget, 4_000, 5_000_000) ||
    Math.floor(value.tokenBudget / value.maxAgents) < 4_000
  ) {
    return undefined
  }
  const retryBackoffMs = Array.from(
    { length: value.retries },
    (_unused, attempt) => Math.min(500 * 2 ** attempt, 5_000),
  ).reduce((total, delayMs) => total + delayMs, 0)
  if (
    value.workflowTimeoutMs <
    value.agentTimeoutMs * (value.retries + 1) + retryBackoffMs
  ) {
    return undefined
  }
  return {
    maxAgents: value.maxAgents,
    concurrency: value.concurrency,
    agentTimeoutMs: value.agentTimeoutMs,
    workflowTimeoutMs: value.workflowTimeoutMs,
    retries: value.retries,
    tokenBudget: value.tokenBudget,
  }
}

const decodeWorkflowRun = (
  value: unknown,
): PersistedWorkflowRun | undefined => {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      "id",
      "label",
      "code",
      "limits",
      "startedAt",
      "updatedAt",
      "status",
      "recoveryCount",
    ]) ||
    typeof value.id !== "string" ||
    !/^wf-\d+$/.test(value.id) ||
    typeof value.label !== "string" ||
    value.label.length < 1 ||
    value.label.length > 80 ||
    typeof value.code !== "string" ||
    value.code.length < 1 ||
    value.code.length > 100_000 ||
    !isIntegerBetween(value.startedAt, 0, Number.MAX_SAFE_INTEGER) ||
    !isIntegerBetween(
      value.updatedAt,
      value.startedAt,
      Number.MAX_SAFE_INTEGER,
    ) ||
    !isIntegerBetween(value.recoveryCount, 0, MAX_WORKFLOW_RECOVERIES) ||
    (value.status !== "running" &&
      value.status !== "completed" &&
      value.status !== "failed" &&
      value.status !== "cancelled")
  ) {
    return undefined
  }
  const limits = decodeLimits(value.limits)
  if (!limits) return undefined
  return {
    id: value.id,
    label: value.label,
    code: value.code,
    limits,
    startedAt: value.startedAt,
    updatedAt: value.updatedAt,
    status: value.status,
    recoveryCount: value.recoveryCount,
  }
}

const decodeWorkflowRuntimeState = (
  value: unknown,
): WorkflowRuntimeState | undefined => {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["runs"]) ||
    !Array.isArray(value.runs) ||
    value.runs.length > MAX_RETAINED_WORKFLOW_RUNS
  ) {
    return undefined
  }
  const runs = value.runs.map(decodeWorkflowRun)
  if (runs.some(run => run === undefined)) return undefined
  const decoded = runs.filter(
    (run): run is PersistedWorkflowRun => run !== undefined,
  )
  if (new Set(decoded.map(({ id }) => id)).size !== decoded.length)
    return undefined
  return { runs: decoded }
}

export const restoreWorkflowRuntimeState = (
  entries: readonly unknown[],
): WorkflowRuntimeState => {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]
    if (
      !isRecord(entry) ||
      entry.type !== "custom" ||
      entry.customType !== WORKFLOW_RUNTIME_ENTRY
    ) {
      continue
    }
    return decodeWorkflowRuntimeState(entry.data) ?? emptyWorkflowRuntimeState
  }
  return emptyWorkflowRuntimeState
}

export const startWorkflowRun = (
  state: WorkflowRuntimeState,
  input: {
    readonly id: string
    readonly label: string
    readonly code: string
    readonly limits: WorkflowLimits
    readonly startedAt: number
  },
): WorkflowRuntimeState => ({
  runs: [
    ...state.runs.filter(({ id }) => id !== input.id),
    {
      ...input,
      updatedAt: input.startedAt,
      status: "running" as const,
      recoveryCount: 0,
    },
  ].slice(-MAX_RETAINED_WORKFLOW_RUNS),
})

export const finishWorkflowRun = (
  state: WorkflowRuntimeState,
  id: string,
  status: Exclude<PersistedWorkflowStatus, "running">,
  updatedAt: number,
): WorkflowRuntimeState => ({
  runs: state.runs.map(run =>
    run.id === id ? { ...run, status, updatedAt } : run,
  ),
})

export const markWorkflowRunRecovered = (
  state: WorkflowRuntimeState,
  id: string,
  updatedAt: number,
): WorkflowRuntimeState => ({
  runs: state.runs.map(run =>
    run.id === id && run.status === "running"
      ? {
          ...run,
          recoveryCount: Math.min(
            MAX_WORKFLOW_RECOVERIES,
            run.recoveryCount + 1,
          ),
          updatedAt,
        }
      : run,
  ),
})

export const recoverableWorkflowRuns = (
  state: WorkflowRuntimeState,
): readonly PersistedWorkflowRun[] =>
  state.runs.filter(
    ({ status, recoveryCount }) =>
      status === "running" && recoveryCount < MAX_WORKFLOW_RECOVERIES,
  )

export const readOnlyRecoveryRequest = (
  request: AgentRequest,
): Effect.Effect<AgentRequest, WorkflowScriptError> => {
  const tools = request.tools ?? ["read", "grep", "find", "ls"]
  return tools.length === 0 ||
    tools.some(tool => !READ_ONLY_RECOVERY_TOOLS.has(tool))
    ? Effect.fail(
        new WorkflowScriptError({
          message:
            "Recovered workflow cannot replay mutation-capable child tools; restart it explicitly after inspecting persisted workflow evidence",
        }),
      )
    : Effect.succeed(request)
}
