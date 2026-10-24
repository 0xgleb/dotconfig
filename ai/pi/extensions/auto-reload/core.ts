import { basename, isAbsolute, join, relative, sep } from "node:path"
import { todoWorkSnapshot } from "../classified-workflows/goal.ts"
import { isContinuationPaused } from "../shared/continuation-pause.ts"

export const HANDOFF_GLOBS = ["*.md", "handoffs/*.md"] as const
export const RELOAD_RESUME_ENTRY = "auto-reload.preempted-generation"
export const RELOAD_FOLLOW_UP_ENTRY = "auto-reload.follow-up-dispatched"
export const RELOAD_HUMAN_INPUT_ENTRY = "auto-reload.human-input"

export const reloadComposerIsSafe = (input: {
  readonly editorText: string
  readonly pendingMessages: boolean
  readonly compactionActive: boolean
}): boolean =>
  input.editorText.length === 0 &&
  !input.pendingMessages &&
  !input.compactionActive

export type ManagedReloadDecision =
  "await-settle" | "reload" | "wait" | "preempt"

export const managedReloadDecision = (input: {
  readonly settled: boolean
  readonly idle: boolean
  readonly pendingForMs: number
  readonly forceAfterMs: number
  readonly preemptRequested: boolean
  readonly pendingMessages?: boolean
}): ManagedReloadDecision => {
  if (!input.settled) return "await-settle"
  if (input.idle) return "reload"
  return "wait"
}

export const isSafeHandoffName: (name: string) => boolean = name => {
  const segments = name.split("/")
  const fileName = segments.at(-1) ?? ""
  const directPiRequest =
    segments.length === 1 && /(?:pi|handoff)/i.test(fileName)
  const dedicatedInboxRequest =
    segments.length === 2 && segments[0] === "handoffs"
  return (
    (directPiRequest || dedicatedInboxRequest) &&
    basename(fileName) === fileName &&
    !fileName.startsWith(".") &&
    fileName.endsWith(".md")
  )
}

export const parseSeenHandoffNames: (value: unknown) => string[] = value => {
  if (
    typeof value !== "object" ||
    value === null ||
    !("names" in value) ||
    !Array.isArray(value.names)
  )
    return []
  return value.names.every(
    name => typeof name === "string" && isSafeHandoffName(name),
  )
    ? value.names
    : []
}

export const unseenHandoffNames: (
  names: readonly string[],
  seen: ReadonlySet<string>,
) => string[] = (names, seen) =>
  names.filter(name => isSafeHandoffName(name) && !seen.has(name)).sort()

export interface ManagedReloadSummary {
  readonly labels: readonly string[]
  readonly createdAt: number
  readonly announced: boolean
}

export const managedReloadDisplayText = (
  labels: readonly string[],
  failure?: string,
): string => {
  if (failure) return `⚠ Reload incomplete · ${failure}`
  const changed = [...new Set(labels)].filter(label => label.length > 0).sort()
  return changed.length > 0
    ? `↻ Reloaded · ${changed.join(", ")}`
    : "↻ Reloaded"
}

export const managedPiChangeLabel: (
  changedPath: string,
  aiRoot: string,
) => string = (changedPath, aiRoot) => {
  const parts = relative(aiRoot, changedPath).split(sep)
  if (parts[0] === "pi" && parts[1] === "extensions" && parts[2])
    return `${parts[2]} extension`
  if (parts[0] === "skills" && parts[1]) return `${parts[1]} skill`
  if (parts[0] === "pi" && parts[1] === "themes") return "Pi theme"
  if (parts.at(-1) === "AGENTS.md") return "agent instructions"
  if (parts.at(-1) === "pi.settings.json") return "Pi settings"
  return "Pi configuration"
}

export const parseManagedReloadSummary: (
  value: unknown,
) => ManagedReloadSummary | undefined = value => {
  if (
    typeof value !== "object" ||
    value === null ||
    !("labels" in value) ||
    !Array.isArray(value.labels) ||
    !value.labels.every(label => typeof label === "string") ||
    !("createdAt" in value) ||
    !Number.isFinite(value.createdAt) ||
    !("announced" in value) ||
    typeof value.announced !== "boolean"
  ) {
    return undefined
  }
  return {
    labels: [...new Set(value.labels)].sort(),
    createdAt: Number(value.createdAt),
    announced: value.announced,
  }
}

const hasActiveWorkflowState = (
  entries: readonly unknown[],
  customType: string,
): boolean => {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]
    if (
      typeof entry !== "object" ||
      entry === null ||
      !("type" in entry) ||
      entry.type !== "custom"
    )
      continue
    if (
      !("customType" in entry) ||
      entry.customType !== customType ||
      !("data" in entry)
    )
      continue
    const data = entry.data
    return (
      typeof data === "object" &&
      data !== null &&
      "status" in data &&
      data.status === "active"
    )
  }
  return false
}

const hasPendingUserQuestion = (entries: readonly unknown[]): boolean => {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]
    if (
      typeof entry !== "object" ||
      entry === null ||
      !("type" in entry) ||
      entry.type !== "custom" ||
      !("customType" in entry) ||
      entry.customType !== "pi.questions.state" ||
      !("data" in entry)
    )
      continue
    const data = entry.data
    if (
      typeof data !== "object" ||
      data === null ||
      !("questions" in data) ||
      !Array.isArray(data.questions)
    )
      return true
    const statuses = data.questions.map(question =>
      typeof question === "object" &&
      question !== null &&
      "status" in question &&
      (question.status === "pending" || question.status === "resolved")
        ? question.status
        : undefined,
    )
    if (statuses.some(status => status === undefined)) return true
    return statuses.some(status => status === "pending")
  }
  return false
}

const isReloadHumanInputMarker = (entry: unknown): boolean =>
  typeof entry === "object" &&
  entry !== null &&
  "type" in entry &&
  entry.type === "custom" &&
  "customType" in entry &&
  entry.customType === RELOAD_HUMAN_INPUT_ENTRY &&
  "data" in entry &&
  typeof entry.data === "object" &&
  entry.data !== null &&
  "observedAt" in entry.data &&
  Number.isSafeInteger(entry.data.observedAt) &&
  Number(entry.data.observedAt) >= 0

const isReloadFollowUpMarker = (entry: unknown): boolean =>
  typeof entry === "object" &&
  entry !== null &&
  "type" in entry &&
  entry.type === "custom" &&
  "customType" in entry &&
  entry.customType === RELOAD_FOLLOW_UP_ENTRY &&
  "data" in entry &&
  typeof entry.data === "object" &&
  entry.data !== null &&
  "requestedAt" in entry.data &&
  Number.isSafeInteger(entry.data.requestedAt) &&
  Number(entry.data.requestedAt) >= 0

const hasHumanInputAfterLastReloadContinuation = (
  entries: readonly unknown[],
): boolean => {
  let deliveryIndex = -1
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]
    if (isReloadFollowUpMarker(entry)) {
      deliveryIndex = index
      break
    }
    if (
      typeof entry === "object" &&
      entry !== null &&
      "type" in entry &&
      entry.type === "custom" &&
      "customType" in entry &&
      entry.customType === RELOAD_RESUME_ENTRY &&
      "data" in entry
    ) {
      const resume = parseReloadResumeMarker(entry.data)
      if (resume?.status === "resumed") {
        deliveryIndex = index
        break
      }
    }
  }
  if (deliveryIndex < 0) return true
  return entries.slice(deliveryIndex + 1).some(isReloadHumanInputMarker)
}

export const shouldDispatchReloadFollowUp: (
  reason: string,
  entries: readonly unknown[],
) => boolean = (reason, entries) => {
  if (
    reason !== "reload" ||
    isContinuationPaused(entries) ||
    hasPendingUserQuestion(entries) ||
    !hasHumanInputAfterLastReloadContinuation(entries)
  )
    return false
  const todos = todoWorkSnapshot(entries as unknown[])
  return (
    todos.pending.length > 0 ||
    hasActiveWorkflowState(entries, "classified-workflows.goal") ||
    hasActiveWorkflowState(entries, "classified-workflows.loop")
  )
}

export interface ReloadResumeMarker {
  readonly requestedAt: number
  readonly status: "pending" | "resumed"
}

export const parseReloadResumeMarker = (
  value: unknown,
): ReloadResumeMarker | undefined => {
  if (
    typeof value !== "object" ||
    value === null ||
    !("requestedAt" in value) ||
    !Number.isSafeInteger(value.requestedAt) ||
    Number(value.requestedAt) < 0 ||
    !("status" in value) ||
    (value.status !== "pending" && value.status !== "resumed")
  )
    return undefined
  return {
    requestedAt: Number(value.requestedAt),
    status: value.status,
  }
}

export const latestReloadResumeMarker = (
  entries: readonly unknown[],
): ReloadResumeMarker | undefined => {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]
    if (
      typeof entry !== "object" ||
      entry === null ||
      !("type" in entry) ||
      entry.type !== "custom" ||
      !("customType" in entry) ||
      entry.customType !== RELOAD_RESUME_ENTRY ||
      !("data" in entry)
    )
      continue
    const marker = parseReloadResumeMarker(entry.data)
    if (marker) return marker
  }
  return undefined
}

export type ManagedReloadDelivery =
  "display" | "displayAndConsumeResume" | "followUp" | "resume"

export const managedReloadDelivery = (
  reason: string,
  entries: readonly unknown[],
  hasPendingMessages: boolean,
): ManagedReloadDelivery => {
  if (reason !== "reload") return "display"
  const resumeMarker = latestReloadResumeMarker(entries)
  if (hasPendingUserQuestion(entries))
    return resumeMarker?.status === "pending"
      ? "displayAndConsumeResume"
      : "display"
  if (resumeMarker?.status === "pending") return "resume"
  if (hasPendingMessages) return "display"
  return shouldDispatchReloadFollowUp(reason, entries) ? "followUp" : "display"
}

export const managedPiWatchPaths: (aiRoot: string) => string[] = aiRoot =>
  isAbsolute(aiRoot)
    ? [
        join(aiRoot, "AGENTS.md"),
        join(aiRoot, "pi.settings.json"),
        join(aiRoot, "pi", "AGENTS.md"),
        join(aiRoot, "pi", "extensions"),
        join(aiRoot, "pi", "themes"),
        join(aiRoot, "skills"),
      ]
    : []
