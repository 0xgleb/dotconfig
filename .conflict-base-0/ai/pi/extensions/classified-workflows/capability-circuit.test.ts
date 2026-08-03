import assert from "node:assert/strict";
import test from "node:test";
import {
  CAPABILITY_CIRCUIT_ENTRY,
  advanceCapabilityCircuit,
  capabilityOutcome,
  emptyCapabilityCircuit,
  restoreCapabilityCircuit,
} from "./capability-circuit.ts";

test("normal local tool use clears capability-blocker history", () => {
  const blocked = advanceCapabilityCircuit(
    emptyCapabilityCircuit,
    "capability-blocked",
    10,
  );
  assert.deepEqual(
    advanceCapabilityCircuit(blocked, "tool-used", 20),
    { consecutiveBlockers: 0, open: false, updatedAt: 20 },
  );
});

test("two consecutive capability-only responses open the todo-loop circuit", () => {
  const first = advanceCapabilityCircuit(
    emptyCapabilityCircuit,
    "capability-blocked",
    10,
  );
  assert.equal(first.open, false);
  assert.deepEqual(
    advanceCapabilityCircuit(first, "capability-blocked", 20),
    { consecutiveBlockers: 2, open: true, updatedAt: 20 },
  );
});

test("assistant capability blockers are detected only when no tool ran", () => {
  assert.equal(
    capabilityOutcome([
      {
        role: "assistant",
        content: [{ type: "text", text: "I cannot access tools because they remain disabled." }],
      },
    ]),
    "capability-blocked",
  );
  assert.equal(
    capabilityOutcome([
      {
        role: "assistant",
        content: [
          { type: "toolCall", name: "read", arguments: { path: "README.md" } },
          { type: "text", text: "Tools worked." },
        ],
      },
    ]),
    "tool-used",
  );
  assert.equal(
    capabilityOutcome([
      { role: "assistant", content: [{ type: "text", text: "The task is blocked on a user decision." }] },
    ]),
    "other",
  );
});

test("the capability circuit survives compaction and reload defensively", () => {
  const state = { consecutiveBlockers: 2, open: true, updatedAt: 42 };
  assert.deepEqual(
    restoreCapabilityCircuit([
      { type: "custom", customType: CAPABILITY_CIRCUIT_ENTRY, data: state },
    ]),
    state,
  );
  assert.deepEqual(
    restoreCapabilityCircuit([
      {
        type: "custom",
        customType: CAPABILITY_CIRCUIT_ENTRY,
        data: { consecutiveBlockers: -1, open: true, updatedAt: 42 },
      },
    ]),
    emptyCapabilityCircuit,
  );
});
