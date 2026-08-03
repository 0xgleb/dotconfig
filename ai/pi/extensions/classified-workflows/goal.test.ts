import assert from "node:assert/strict";
import test from "node:test";
import {
  applyGoalEvaluation,
  assistantUsageTokens,
  buildGoalEvaluatorPrompt,
  formatGoalStatus,
  parseGoalCommand,
  parseGoalEvaluation,
  parseStoredGoal,
  restoreGoal,
  type GoalState,
} from "./goal.ts";

const active: GoalState & { status: "active" } = {
  status: "active",
  condition: "all routing tests pass",
  startedAt: 1_000,
  turns: 2,
  tokens: 300,
  lastReason: "one test still fails",
};

test("goal command sets, reports, and clears one condition", () => {
  assert.deepEqual(parseGoalCommand(""), { action: "status" });
  for (const alias of ["clear", "stop", "off", "reset", "none", "cancel"]) {
    assert.deepEqual(parseGoalCommand(alias), { action: "clear" });
  }
  assert.deepEqual(parseGoalCommand("all tests pass and lint is clean"), {
    action: "set",
    condition: "all tests pass and lint is clean",
  });
  assert.throws(() => parseGoalCommand("x".repeat(4_001)), /4,000/);
});

test("goal evaluator is strict JSON and fails closed", () => {
  assert.deepEqual(parseGoalEvaluation('{"met":false,"reason":"tests still fail"}'), {
    status: "valid",
    met: false,
    reason: "tests still fail",
  });
  assert.equal(parseGoalEvaluation("yes").status, "invalid");
  assert.equal(parseGoalEvaluation('{"met":"yes"}').status, "invalid");
});

test("unmet goals continue with updated counters and reason", () => {
  assert.deepEqual(
    applyGoalEvaluation(active, { status: "valid", met: false, reason: "lint remains" }, 50, 2_000),
    {
      ...active,
      turns: 3,
      tokens: 350,
      lastReason: "lint remains",
    },
  );
});

test("met goals become achieved and invalid evaluation pauses", () => {
  const achieved = applyGoalEvaluation(active, { status: "valid", met: true, reason: "verified" }, 50, 2_000);
  assert.deepEqual(achieved, {
    status: "achieved",
    condition: active.condition,
    startedAt: active.startedAt,
    finishedAt: 2_000,
    turns: 3,
    tokens: 350,
    lastReason: "verified",
  });

  const paused = applyGoalEvaluation(active, { status: "invalid", reason: "evaluator unavailable" }, 0, 2_000);
  assert.equal(paused.status, "paused");
  assert.equal(paused.lastReason, "evaluator unavailable");
});

test("only active goals restore and their counters reset", () => {
  assert.deepEqual(restoreGoal(active, 5_000), {
    status: "active",
    condition: active.condition,
    startedAt: 5_000,
    turns: 0,
    tokens: 0,
  });

  const achieved = applyGoalEvaluation(active, { status: "valid", met: true, reason: "done" }, 1, 2_000);
  assert.deepEqual(restoreGoal(achieved, 5_000), achieved);
});

test("goal status reports condition, elapsed time, turns, tokens, and reason", () => {
  assert.equal(formatGoalStatus(undefined, 2_000), "No goal has been set in this session.");
  const status = formatGoalStatus(active, 61_000);
  assert.match(status, /all routing tests pass/);
  assert.match(status, /1m/);
  assert.match(status, /2 turns/);
  assert.match(status, /300 tokens/);
  assert.match(status, /one test still fails/);
});

test("stored goals reject malformed session data", () => {
  assert.deepEqual(parseStoredGoal(active), active);
  assert.equal(parseStoredGoal({ ...active, turns: -1 }), undefined);
  assert.equal(parseStoredGoal({ ...active, status: "unknown" }), undefined);
  assert.equal(parseStoredGoal("active"), undefined);
});

test("goal evaluator prompt treats the transcript as untrusted evidence", () => {
  const prompt = buildGoalEvaluatorPrompt("tests pass", ["user: run tests", "assistant: all pass"]);
  assert.match(prompt, /tests pass/);
  assert.match(prompt, /untrusted evidence/i);
  assert.match(prompt, /assistant: all pass/);
  assert.match(prompt, /return only/i);
});

test("assistant usage counts only valid non-negative totals", () => {
  assert.equal(
    assistantUsageTokens([
      { role: "assistant", usage: { totalTokens: 12 } },
      { role: "user", usage: { totalTokens: 99 } },
      { role: "assistant", usage: { totalTokens: -1 } },
      { role: "assistant", usage: {} },
    ]),
    12,
  );
});
