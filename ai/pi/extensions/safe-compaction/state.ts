export const SAFE_COMPACTION_ENTRY = "safe-compaction.state";

export type CompactionReason = "manual" | "threshold" | "overflow";

export type SafeCompactionState =
  | { readonly phase: "idle" }
  | {
      readonly phase: "preparing";
      readonly reason: Exclude<CompactionReason, "overflow">;
      readonly requestedAt: number;
    }
  | {
      readonly phase: "ready";
      readonly reason: Exclude<CompactionReason, "overflow">;
      readonly requestedAt: number;
      readonly readyAt: number;
      readonly resumeNotes: string;
    }
  | {
      readonly phase: "forced";
      readonly reason: CompactionReason;
      readonly requestedAt: number;
      readonly resumeNotes: string;
    };

export const idleSafeCompactionState: SafeCompactionState = { phase: "idle" };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isTimestamp = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;

export const decodeSafeCompactionState = (value: unknown): SafeCompactionState | undefined => {
  if (!isRecord(value) || typeof value.phase !== "string") return undefined;
  if (value.phase === "idle") return idleSafeCompactionState;
  if (!isTimestamp(value.requestedAt)) return undefined;
  if (value.reason !== "manual" && value.reason !== "threshold" && value.reason !== "overflow") return undefined;
  if (value.phase === "preparing" && value.reason !== "overflow") {
    return { phase: "preparing", reason: value.reason, requestedAt: value.requestedAt };
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
    };
  }
  if (value.phase === "forced" && typeof value.resumeNotes === "string") {
    return {
      phase: "forced",
      reason: value.reason,
      requestedAt: value.requestedAt,
      resumeNotes: value.resumeNotes.slice(0, 4_000),
    };
  }
  return undefined;
};

export const restoreSafeCompactionState = (entries: readonly unknown[]): SafeCompactionState => {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (!isRecord(entry) || entry.type !== "custom" || entry.customType !== SAFE_COMPACTION_ENTRY) continue;
    const state = decodeSafeCompactionState(entry.data);
    if (state) return state;
  }
  return idleSafeCompactionState;
};

export interface BeforeCompactionTransition {
  readonly state: SafeCompactionState;
  readonly cancel: boolean;
  readonly notifyPreparation: boolean;
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
              requestedAt: state.phase === "preparing" ? state.requestedAt : now,
              resumeNotes:
                "Compaction was forced by context overflow. Reconcile the last assistant message and tool results; any displayed tool call without a successful result remains unfinished and must be reissued with complete arguments.",
            },
      cancel: false,
      notifyPreparation: false,
    };
  }
  if (state.phase === "idle") {
    return {
      state: { phase: "preparing", reason, requestedAt: now },
      cancel: true,
      notifyPreparation: true,
    };
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
    };
  }
  return { state, cancel: false, notifyPreparation: false };
};

export const preparationMessage = (reason: "manual" | "threshold"): string =>
  `Safe compaction is pending (${reason}). Before context is summarized:\n` +
  "1. Reconcile the active goal and every pending or blocked todo.\n" +
  "2. Persist durable facts, decisions, exact pause points, and unfinished tool actions through the appropriate todo, memory, registry, or project artifact.\n" +
  "3. Treat a displayed tool call without a successful tool result as NOT executed. If output limits truncated its arguments, record that it must be reissued completely after compaction.\n" +
  "4. Call safe_compaction_ready with concise resume notes naming the exact next action. Do not stop merely because compaction is pending.";

const MAX_FALLBACK_PREVIOUS_SUMMARY = 32_000;

export const overflowFallbackSummary = (previousSummary: string | undefined, resumeNotes: string): string => {
  const prior = previousSummary?.trim().slice(-MAX_FALLBACK_PREVIOUS_SUMMARY);
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
    ...(prior ? ["", "### Previous checkpoint (bounded tail)", prior] : []),
  ].join("\n");
};

export const resumeMessage = (state: Exclude<SafeCompactionState, { phase: "idle" | "preparing" }>): string =>
  `Safe compaction completed. Resume all assigned work now. Do not stop while a goal or pending todo remains.\n\nPre-compaction resume notes:\n${state.resumeNotes}`;
