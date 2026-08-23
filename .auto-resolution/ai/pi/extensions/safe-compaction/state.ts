export const SAFE_COMPACTION_ENTRY = "safe-compaction.state"

export type CompactionReason = "manual" | "threshold" | "overflow"

export type SafeCompactionState =
  | {
      readonly phase: "idle"
      readonly thresholdBlockedUntilInput?: true
    }
  | {
      readonly phase: "preparing"
      readonly reason: Exclude<CompactionReason, "overflow">
      readonly requestedAt: number
    }
  | {
      readonly phase: "ready"
      readonly reason: Exclude<CompactionReason, "overflow">
      readonly requestedAt: number
      readonly readyAt: number
      readonly resumeNotes: string
    }
  | {
      readonly phase: "forced"
      readonly reason: CompactionReason
      readonly requestedAt: number
      readonly resumeNotes: string
      readonly suppressAutomaticResume?: true
    }

export const idleSafeCompactionState: SafeCompactionState = { phase: "idle" }
export const thresholdBlockedSafeCompactionState: SafeCompactionState = {
  phase: "idle",
  thresholdBlockedUntilInput: true,
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const isTimestamp = (value: unknown): value is number =>
  Number.isSafeInteger(value) && Number(value) >= 0

export const decodeSafeCompactionState = (
  value: unknown,
): SafeCompactionState | undefined => {
  if (!isRecord(value) || typeof value.phase !== "string") return undefined
  if (value.phase === "idle") {
    if (value.thresholdBlockedUntilInput === undefined)
      return idleSafeCompactionState
    return value.thresholdBlockedUntilInput === true
      ? thresholdBlockedSafeCompactionState
      : undefined
  }
  if (!isTimestamp(value.requestedAt)) return undefined
  if (
    value.reason !== "manual" &&
    value.reason !== "threshold" &&
    value.reason !== "overflow"
  )
    return undefined
  if (value.phase === "preparing" && value.reason !== "overflow") {
    return {
      phase: "preparing",
      reason: value.reason,
      requestedAt: value.requestedAt,
    }
  }
  if (
    value.phase === "ready" &&
    value.reason !== "overflow" &&
    isTimestamp(value.readyAt) &&
    typeof value.resumeNotes === "string"
  ) {
    return {
      phase: "ready",
      reason: value.reason,
      requestedAt: value.requestedAt,
      readyAt: value.readyAt,
      resumeNotes: value.resumeNotes.slice(0, 4_000),
    }
  }
  if (value.phase === "forced" && typeof value.resumeNotes === "string") {
    if (
      value.suppressAutomaticResume !== undefined &&
      value.suppressAutomaticResume !== true
    )
      return undefined
    return {
      phase: "forced",
      reason: value.reason,
      requestedAt: value.requestedAt,
      resumeNotes: value.resumeNotes.slice(0, 4_000),
      ...(value.suppressAutomaticResume === true
        ? { suppressAutomaticResume: true as const }
        : {}),
    }
  }
  return undefined
}

export const restoreSafeCompactionState = (
  entries: readonly unknown[],
): SafeCompactionState => {
  let compactionObserved = false
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]
    if (!isRecord(entry)) continue
    if (entry.type === "compaction") {
      compactionObserved = true
      continue
    }
    if (entry.type !== "custom" || entry.customType !== SAFE_COMPACTION_ENTRY)
      continue
    const state = decodeSafeCompactionState(entry.data)
    if (!state) continue
    if (compactionObserved && state.phase !== "idle")
      return state.reason === "manual"
        ? idleSafeCompactionState
        : thresholdBlockedSafeCompactionState
    return state
  }
  return idleSafeCompactionState
}

export interface BeforeCompactionTransition {
  readonly state: SafeCompactionState
  readonly cancel: boolean
  readonly notifyPreparation: boolean
}

export const beforeCompactionTransition = (
  state: SafeCompactionState,
  reason: CompactionReason,
  now: number,
): BeforeCompactionTransition => {
  if (reason === "overflow") {
    return {
      state:
        state.phase === "ready" || state.phase === "forced"
          ? state
          : {
              phase: "forced",
              reason,
              requestedAt:
                state.phase === "preparing" ? state.requestedAt : now,
              resumeNotes:
                "Compaction was forced by context overflow. Reconcile the last assistant message and tool results; any displayed tool call without a successful result remains unfinished and must be reissued with complete arguments.",
              ...(state.phase === "idle" && state.thresholdBlockedUntilInput
                ? { suppressAutomaticResume: true as const }
                : {}),
            },
      cancel: false,
      notifyPreparation: false,
    }
  }
  if (state.phase === "idle") {
    if (reason === "threshold" && state.thresholdBlockedUntilInput) {
      return {
        state,
        cancel: true,
        notifyPreparation: false,
      }
    }
    return {
      state: { phase: "preparing", reason, requestedAt: now },
      cancel: true,
      notifyPreparation: true,
    }
  }
  if (state.phase === "preparing") {
    return {
      state: {
        phase: "forced",
        reason,
        requestedAt: state.requestedAt,
        resumeNotes:
          "The bounded preparation turn ended without a readiness acknowledgement. Resume the active goal and todos, and treat every tool call lacking a successful tool result as unfinished.",
      },
      cancel: false,
      notifyPreparation: false,
    }
  }
  return { state, cancel: false, notifyPreparation: false }
}

export const preparationMessage = (reason: "manual" | "threshold"): string =>
  `${reason === "manual" ? "Manual checkpoint requested" : "Context limit reached"}. Before Pi summarizes this context:\n` +
  "1. Reconcile the active goal and every pending or blocked todo.\n" +
  "2. Persist durable facts, decisions, exact pause points, and unfinished tool actions through the appropriate todo, memory, registry, or project artifact.\n" +
  "3. Treat a displayed tool call without a successful tool result as NOT executed. If output limits truncated its arguments, record that it must be reissued completely after compaction.\n" +
  "4. Call safe_compaction_ready with concise resume notes naming the exact next action. Do not stop merely because this checkpoint is pending."

const MAX_FALLBACK_PREVIOUS_SUMMARY = 32_000
const PREVIOUS_CHECKPOINT_HEADING = "\n### Previous checkpoint (bounded tail)"

const rootCheckpoint = (summary: string | undefined): string | undefined => {
  const root = summary?.split(PREVIOUS_CHECKPOINT_HEADING, 1)[0]?.trim()
  if (!root || root.includes("**Model-free overflow recovery**"))
    return undefined
  return root.slice(-MAX_FALLBACK_PREVIOUS_SUMMARY)
}

export type CompactionResumeMode =
  | "host-retry"
  | "agent-settled"
  | "manual-complete"

export const compactionResumeMode = (
  reason: CompactionReason,
  willRetry: boolean,
): CompactionResumeMode => {
  if (willRetry) return "host-retry"
  return reason === "manual" ? "manual-complete" : "agent-settled"
}

export const overflowRecoveryFirstKeptEntryId = (
  branchEntries: readonly unknown[],
  defaultFirstKeptEntryId: string,
): string => {
  for (let index = branchEntries.length - 1; index >= 0; index -= 1) {
    const entry = branchEntries[index]
    if (!isRecord(entry)) continue
    if (entry.type === "compaction") break
    if (entry.type !== "message" || typeof entry.id !== "string") continue
    const message = entry.message
    if (
      !isRecord(message) ||
      message.role !== "assistant" ||
      message.stopReason !== "error"
    )
      continue
    return entry.id
  }
  return defaultFirstKeptEntryId
}

const MAX_LATEST_USER_REQUEST = 8_000

export const latestBoundedUserRequest = (
  branchEntries: readonly unknown[],
): string | undefined => {
  for (let index = branchEntries.length - 1; index >= 0; index -= 1) {
    const entry = branchEntries[index]
    if (
      !isRecord(entry) ||
      entry.type !== "message" ||
      !isRecord(entry.message)
    )
      continue
    const message = entry.message
    if (message.role !== "user") continue
    const raw =
      typeof message.content === "string"
        ? message.content
        : Array.isArray(message.content)
          ? message.content
              .filter(
                (part): part is Record<string, unknown> =>
                  isRecord(part) && part.type === "text",
              )
              .map(part => (typeof part.text === "string" ? part.text : ""))
              .join("\n")
          : ""
    const bounded = raw
      .replace(/[\u0000-\u001f\u007f]+/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, MAX_LATEST_USER_REQUEST)
    return bounded || undefined
  }
  return undefined
}

export const overflowFallbackSummary = (
  previousSummary: string | undefined,
  resumeNotes: string,
  latestUserRequest?: string,
): string => {
  const prior = rootCheckpoint(previousSummary)
  return [
    "## Goal",
    "Resume the durable active goal and branch-aware todos restored by the loaded Pi extensions.",
    "",
    "## Constraints & Preferences",
    "- Context overflow forced a model-free fallback checkpoint; do not claim omitted history as new evidence.",
    "- A displayed tool call without a successful tool result remains unfinished.",
    "",
    "## Progress",
    "### Done",
    "- [x] Preserved persisted goal, todo, registry, loop, and safe-compaction state.",
    "",
    "### In Progress",
    "- [ ] Reconcile the retained recent messages with durable goal and todo state, then continue the exact active task.",
    "",
    "### Blocked",
    "- The normal LLM summarization request exceeded the model context window.",
    "",
    "## Key Decisions",
    "- **Model-free overflow recovery**: Prefer a bounded deterministic checkpoint over an infinite compact-and-retry loop.",
    "",
    "## Next Steps",
    "1. Inspect the retained recent tool results and durable todos.",
    "2. Resume the exact unfinished action named in the notes below.",
    "3. Do not rerun successful mutations whose output was merely filtered.",
    "",
    "## Critical Context",
    `- Resume notes: ${resumeNotes}`,
    ...(latestUserRequest
      ? [`- Latest user request before overflow: ${latestUserRequest}`]
      : []),
    ...(prior ? ["", "### Previous checkpoint (bounded tail)", prior] : []),
  ].join("\n")
}

export const resumeMessage = (
  state: Exclude<SafeCompactionState, { phase: "idle" | "preparing" }>,
): string =>
  `Context restored from ${state.reason === "overflow" ? "an" : "a"} ${state.reason} checkpoint. This checkpoint is complete: any retained preparation instruction is stale, so do not call safe_compaction_ready for it. Resume all assigned work now. Do not stop while a goal or pending todo remains.\n\nCheckpoint notes:\n${state.resumeNotes}`
