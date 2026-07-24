import assert from "node:assert/strict";
import test from "node:test";
import {
  SAFE_COMPACTION_ENTRY,
  beforeCompactionTransition,
  decodeSafeCompactionState,
  idleSafeCompactionState,
  overflowFallbackSummary,
  preparationMessage,
  restoreSafeCompactionState,
  resumeMessage,
} from "./state.ts";

test("threshold compaction first pauses for one explicit preparation turn", () => {
  const transition = beforeCompactionTransition(idleSafeCompactionState, "threshold", 100);
  assert.deepEqual(transition, {
    state: { phase: "preparing", reason: "threshold", requestedAt: 100 },
    cancel: true,
    notifyPreparation: true,
  });
  assert.match(preparationMessage("threshold"), /Call safe_compaction_ready/);
  assert.match(preparationMessage("threshold"), /tool call without a successful tool result as NOT executed/i);
  assert.match(preparationMessage("threshold"), /Do not stop merely because compaction is pending/);
});

test("a missing readiness acknowledgement cannot postpone compaction until hard failure", () => {
  const preparing = beforeCompactionTransition(idleSafeCompactionState, "threshold", 100).state;
  const transition = beforeCompactionTransition(preparing, "threshold", 200);
  assert.equal(transition.cancel, false);
  assert.equal(transition.notifyPreparation, false);
  assert.equal(transition.state.phase, "forced");
  if (transition.state.phase === "forced") {
    assert.match(transition.state.resumeNotes, /tool call lacking a successful tool result as unfinished/i);
  }
});

test("overflow compacts immediately but preserves interrupted tool-call recovery", () => {
  const transition = beforeCompactionTransition(idleSafeCompactionState, "overflow", 300);
  assert.equal(transition.cancel, false);
  assert.equal(transition.state.phase, "forced");
  if (transition.state.phase !== "forced") return;
  assert.match(transition.state.resumeNotes, /without a successful result remains unfinished/i);
  assert.match(resumeMessage(transition.state), /Resume all assigned work now/);
  assert.match(resumeMessage(transition.state), /must be reissued with complete arguments/i);
});

test("overflow fallback is model-free, bounded, and keeps durable recovery instructions", () => {
  const summary = overflowFallbackSummary(`old-${"x".repeat(50_000)}`, "Resume exact todo #43 without retrying completed writes.");
  assert.match(summary, /Model-free overflow recovery/);
  assert.match(summary, /Resume exact todo #43/);
  assert.match(summary, /Previous checkpoint \(bounded tail\)/);
  assert.equal(summary.includes("old-"), false);
  assert.equal(summary.length < 36_000, true);
});

test("readiness and exact resume notes survive reload", () => {
  const state = {
    phase: "ready" as const,
    reason: "manual" as const,
    requestedAt: 1,
    readyAt: 2,
    resumeNotes: "Reissue write with complete content, verify the file, then finish EOD.",
  };
  assert.deepEqual(decodeSafeCompactionState(state), state);
  assert.deepEqual(
    restoreSafeCompactionState([{ type: "custom", customType: SAFE_COMPACTION_ENTRY, data: state }]),
    state,
  );
  assert.match(resumeMessage(state), /Reissue write with complete content/);
});

test("malformed persisted compaction state fails closed to idle", () => {
  assert.equal(decodeSafeCompactionState({ phase: "ready", resumeNotes: "skip" }), undefined);
  assert.deepEqual(
    restoreSafeCompactionState([{ type: "custom", customType: SAFE_COMPACTION_ENTRY, data: { phase: "wat" } }]),
    idleSafeCompactionState,
  );
});
