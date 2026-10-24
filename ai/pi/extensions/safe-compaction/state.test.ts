import assert from "node:assert/strict"
import test from "node:test"
import {
  SAFE_COMPACTION_ENTRY,
  beforeCompactionTransition,
  compactionResumeMode,
  decodeSafeCompactionState,
  idleSafeCompactionState,
  latestBoundedUserRequest,
  overflowFallbackSummary,
  overflowRecoveryFirstKeptEntryId,
  preparationMessage,
  restoreSafeCompactionState,
  resumeMessage,
} from "./state.ts"

test("threshold compaction first pauses for one explicit preparation turn", () => {
  const transition = beforeCompactionTransition(
    idleSafeCompactionState,
    "threshold",
    100,
  )
  assert.deepEqual(transition, {
    state: { phase: "preparing", reason: "threshold", requestedAt: 100 },
    cancel: true,
    notifyPreparation: true,
  })
  assert.match(preparationMessage("threshold"), /Call safe_compaction_ready/)
  assert.match(
    preparationMessage("threshold"),
    /tool call without a successful tool result as NOT executed/i,
  )
  assert.match(
    preparationMessage("threshold"),
    /Do not stop merely because this checkpoint is pending/,
  )
  assert.match(preparationMessage("threshold"), /Context limit reached/)
  assert.doesNotMatch(
    preparationMessage("threshold"),
    /Safe compaction is pending/,
  )
})

test("a missing readiness acknowledgement cannot postpone compaction until hard failure", () => {
  const preparing = beforeCompactionTransition(
    idleSafeCompactionState,
    "threshold",
    100,
  ).state
  const transition = beforeCompactionTransition(preparing, "threshold", 200)
  assert.equal(transition.cancel, false)
  assert.equal(transition.notifyPreparation, false)
  assert.equal(transition.state.phase, "forced")
  if (transition.state.phase === "forced") {
    assert.match(
      transition.state.resumeNotes,
      /tool call lacking a successful tool result as unfinished/i,
    )
  }
})

test("overflow compacts immediately but preserves interrupted tool-call recovery", () => {
  const transition = beforeCompactionTransition(
    idleSafeCompactionState,
    "overflow",
    300,
  )
  assert.equal(transition.cancel, false)
  assert.equal(transition.state.phase, "forced")
  if (transition.state.phase !== "forced") return
  assert.match(
    transition.state.resumeNotes,
    /without a successful result remains unfinished/i,
  )
  assert.match(
    resumeMessage(transition.state),
    /Context restored from an overflow checkpoint/,
  )
  assert.match(resumeMessage(transition.state), /Resume all assigned work now/)
  assert.match(
    resumeMessage(transition.state),
    /checkpoint is complete.*do not call safe_compaction_ready/is,
  )
  assert.match(
    resumeMessage(transition.state),
    /must be reissued with complete arguments/i,
  )
})

test("overflow recovery advances past the provider-rejected retained tail", () => {
  const entries = [
    {
      type: "message",
      id: "user-1",
      message: { role: "user", content: "Continue exact todo #24" },
    },
    {
      type: "message",
      id: "assistant-1",
      message: { role: "assistant", stopReason: "toolUse" },
    },
    {
      type: "message",
      id: "tool-1",
      message: { role: "toolResult", content: "x".repeat(100_000) },
    },
    {
      type: "message",
      id: "overflow-1",
      message: { role: "assistant", stopReason: "error", content: [] },
    },
  ]
  assert.equal(
    overflowRecoveryFirstKeptEntryId(entries, "user-1"),
    "overflow-1",
  )
  assert.equal(latestBoundedUserRequest(entries), "Continue exact todo #24")
  assert.match(
    overflowFallbackSummary(
      undefined,
      "Resume durable work",
      latestBoundedUserRequest(entries),
    ),
    /Latest user request before overflow: Continue exact todo #24/,
  )
})

test("overflow recovery never reuses an error before the latest compaction", () => {
  const entries = [
    {
      type: "message",
      id: "stale-overflow",
      message: { role: "assistant", stopReason: "error", content: [] },
    },
    { type: "compaction", id: "checkpoint-1" },
    {
      type: "message",
      id: "current-answer",
      message: { role: "assistant", stopReason: "stop", content: [] },
    },
  ]
  assert.equal(
    overflowRecoveryFirstKeptEntryId(entries, "current-answer"),
    "current-answer",
  )

  entries.push({
    type: "message",
    id: "current-overflow",
    message: { role: "assistant", stopReason: "error", content: [] },
  })
  assert.equal(
    overflowRecoveryFirstKeptEntryId(entries, "current-answer"),
    "current-overflow",
  )
})

test("overflow fallback is model-free, bounded, and keeps durable recovery instructions", () => {
  const summary = overflowFallbackSummary(
    `old-${"x".repeat(50_000)}`,
    "Resume exact todo #43 without retrying completed writes.",
  )
  assert.match(summary, /Model-free overflow recovery/)
  assert.match(summary, /Resume exact todo #43/)
  assert.match(summary, /Previous checkpoint \(bounded tail\)/)
  assert.equal(summary.includes("old-"), false)
  assert.equal(summary.length < 36_000, true)
})

test("repeated overflow fallback compaction does not recursively nest checkpoints", () => {
  const first = overflowFallbackSummary("original checkpoint", "resume first")
  const second = overflowFallbackSummary(first, "resume second")
  const third = overflowFallbackSummary(second, "resume third")
  assert.equal(
    third.match(/### Previous checkpoint \(bounded tail\)/g)?.length ?? 0,
    0,
  )
  assert.equal(third.length <= first.length, true)
})

test("compaction resume waits for the owning lifecycle boundary", () => {
  assert.equal(compactionResumeMode("overflow", true), "host-retry")
  assert.equal(compactionResumeMode("overflow", false), "agent-settled")
  assert.equal(compactionResumeMode("threshold", false), "agent-settled")
  assert.equal(compactionResumeMode("manual", false), "manual-complete")
})

test("threshold resume cannot immediately compact again before human input", () => {
  const blockedUntilInput = {
    phase: "idle" as const,
    thresholdBlockedUntilInput: true as const,
  }

  assert.deepEqual(
    decodeSafeCompactionState(blockedUntilInput),
    blockedUntilInput,
  )
  assert.deepEqual(
    beforeCompactionTransition(blockedUntilInput, "threshold", 400),
    {
      state: blockedUntilInput,
      cancel: true,
      notifyPreparation: false,
    },
  )
  assert.deepEqual(
    beforeCompactionTransition(blockedUntilInput, "overflow", 450),
    {
      state: {
        phase: "forced",
        reason: "overflow",
        requestedAt: 450,
        resumeNotes:
          "Compaction was forced by context overflow. Reconcile the last assistant message and tool results; any displayed tool call without a successful result remains unfinished and must be reissued with complete arguments.",
        suppressAutomaticResume: true,
      },
      cancel: false,
      notifyPreparation: false,
    },
    "an extension-originated resume may compact again but cannot enqueue another identical resume",
  )
  assert.deepEqual(
    beforeCompactionTransition(blockedUntilInput, "manual", 500),
    {
      state: { phase: "preparing", reason: "manual", requestedAt: 500 },
      cancel: true,
      notifyPreparation: true,
    },
  )
})

test("a completed compaction invalidates an older preparing checkpoint on reload", () => {
  assert.deepEqual(
    restoreSafeCompactionState([
      {
        type: "custom",
        customType: SAFE_COMPACTION_ENTRY,
        data: { phase: "preparing", reason: "threshold", requestedAt: 100 },
      },
      { type: "compaction", id: "checkpoint-1" },
    ]),
    { phase: "idle", thresholdBlockedUntilInput: true },
  )
  assert.deepEqual(
    restoreSafeCompactionState([
      {
        type: "custom",
        customType: SAFE_COMPACTION_ENTRY,
        data: {
          phase: "ready",
          reason: "manual",
          requestedAt: 100,
          readyAt: 110,
          resumeNotes: "resume",
        },
      },
      { type: "compaction", id: "checkpoint-2" },
    ]),
    idleSafeCompactionState,
  )
})

test("readiness and exact resume notes survive reload", () => {
  const state = {
    phase: "ready" as const,
    reason: "manual" as const,
    requestedAt: 1,
    readyAt: 2,
    resumeNotes:
      "Reissue write with complete content, verify the file, then finish EOD.",
  }
  assert.deepEqual(decodeSafeCompactionState(state), state)
  assert.deepEqual(
    restoreSafeCompactionState([
      { type: "custom", customType: SAFE_COMPACTION_ENTRY, data: state },
    ]),
    state,
  )
  assert.match(resumeMessage(state), /Reissue write with complete content/)
})

test("malformed persisted compaction state fails closed to idle", () => {
  assert.equal(
    decodeSafeCompactionState({
      phase: "idle",
      thresholdBlockedUntilInput: false,
    }),
    undefined,
  )
  assert.equal(
    decodeSafeCompactionState({ phase: "ready", resumeNotes: "skip" }),
    undefined,
  )
  assert.deepEqual(
    restoreSafeCompactionState([
      {
        type: "custom",
        customType: SAFE_COMPACTION_ENTRY,
        data: { phase: "wat" },
      },
    ]),
    idleSafeCompactionState,
  )
})
