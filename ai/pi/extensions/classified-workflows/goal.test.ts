import assert from "node:assert/strict"
import test from "node:test"
import { Effect } from "effect"
import {
  applyGoalEvaluation,
  assistantUsageTokens,
  buildGoalEvaluatorPrompt,
  formatGoalStatus,
  latestCompactionSummary,
  parseGoalCommand as parseGoalCommandEffect,
  parseGoalEvaluation,
  parseStoredGoal,
  pendingTodoTexts,
  recoverLatestIndependentGoal,
  restoreGoal,
  taskContinuationMessage,
  todoClassifierIntent,
  todoWorkSnapshot,
  type GoalState,
} from "./goal.ts"

const parseGoalCommand = (args: string) =>
  Effect.runSync(parseGoalCommandEffect(args))

const active: GoalState & { status: "active" } = {
  status: "active",
  condition: "all routing tests pass",
  startedAt: 1_000,
  turns: 2,
  tokens: 300,
  lastReason: "one test still fails",
}

test("goal command sets, reports, and clears only by exact clear command", () => {
  assert.deepEqual(parseGoalCommand(""), { action: "status" })
  assert.deepEqual(parseGoalCommand("clear"), { action: "clear" })
  for (const condition of ["stop", "off", "reset", "none", "cancel"]) {
    assert.deepEqual(parseGoalCommand(condition), { action: "set", condition })
  }
  assert.deepEqual(parseGoalCommand("all tests pass and lint is clean"), {
    action: "set",
    condition: "all tests pass and lint is clean",
  })
  assert.throws(() => parseGoalCommand("x".repeat(4_001)), /4,000/)
})

test("goal evaluator is strict JSON and fails closed", () => {
  assert.deepEqual(
    parseGoalEvaluation('{"met":false,"reason":"tests still fail"}'),
    {
      status: "valid",
      met: false,
      reason: "tests still fail",
    },
  )
  assert.equal(parseGoalEvaluation("yes").status, "invalid")
  assert.equal(parseGoalEvaluation('{"met":"yes"}').status, "invalid")
})

test("unmet goals continue with updated counters and reason", () => {
  assert.deepEqual(
    applyGoalEvaluation(
      active,
      { status: "valid", met: false, reason: "lint remains" },
      50,
      2_000,
    ),
    {
      ...active,
      turns: 3,
      tokens: 350,
      lastReason: "lint remains",
    },
  )
})

test("pending branch-aware todos prevent optimistic goal completion", () => {
  const guarded = applyGoalEvaluation(
    active,
    { status: "valid", met: true, reason: "looks complete" },
    50,
    2_000,
    ["Fix child workflow exits", "Commit and push"],
  )
  assert.equal(guarded.status, "active")
  assert.match(guarded.lastReason ?? "", /tracked work remains/i)
  assert.match(guarded.lastReason ?? "", /Fix child workflow exits/)
})

test("latest todo snapshot supplies pending completion evidence", () => {
  const entries = [
    {
      type: "message",
      message: {
        role: "toolResult",
        toolName: "todo",
        details: {
          outcome: "success",
          action: "add",
          state: {
            todos: [{ id: 1, text: "Old task", status: "pending" }],
            nextId: 2,
          },
        },
      },
    },
    {
      type: "message",
      message: {
        role: "toolResult",
        toolName: "todo",
        details: {
          outcome: "success",
          action: "toggle",
          state: {
            todos: [
              {
                id: 1,
                text: "Repair return distribution",
                status: "completed",
                replies: [
                  "29 focused tests, typecheck, lint, and localhost VRT pass",
                ],
              },
              { id: 2, text: "Finish handover", status: "pending" },
              {
                id: 3,
                text: "Deploy",
                status: "blocked",
                reason: "No production access",
              },
            ],
            nextId: 3,
          },
        },
      },
    },
  ]
  assert.deepEqual(pendingTodoTexts(entries), ["#2 Finish handover"])
  assert.deepEqual(todoWorkSnapshot(entries), {
    pending: ["#2 Finish handover"],
    blocked: ["#3 Deploy — No production access"],
    completed: [
      "#1 Repair return distribution — 29 focused tests, typecheck, lint, and localhost VRT pass",
    ],
  })
  assert.deepEqual(pendingTodoTexts([{ type: "wrong" }]), [])
})

test("current typed todo intent distinguishes active work from completed history", () => {
  assert.deepEqual(
    todoClassifierIntent({
      pending: ["#49 Annualized return distribution"],
      blocked: [],
      completed: ["#4 Chart annotations — live v1.10.97"],
    }),
    [
      "Current typed active todo: #49 Annualized return distribution",
      "Current typed completed todo (not active scope): #4 Chart annotations — live v1.10.97",
    ],
  )
})

test("durable custom todo state survives compaction for classifier intent", () => {
  const snapshot = todoWorkSnapshot([
    {
      type: "custom",
      customType: "todo.state",
      data: {
        todos: [
          {
            id: 10,
            text: "Separate typed allocation changes",
            status: "pending",
          },
          {
            id: 23,
            text: "Repair rebuy hotfix",
            status: "blocked",
            reason: "classifier denied staging",
          },
        ],
        nextId: 24,
      },
    },
  ])
  assert.deepEqual(snapshot.pending, ["#10 Separate typed allocation changes"])
  assert.deepEqual(snapshot.blocked, [
    "#23 Repair rebuy hotfix — classifier denied staging",
  ])
  assert.deepEqual(snapshot.completed, [])
})

test("latest compaction summary remains available as bounded classifier evidence", () => {
  assert.equal(
    latestCompactionSummary([
      { type: "compaction", summary: "Todo #10: old" },
      { type: "message", message: { role: "user", content: "continue" } },
      { type: "compaction", summary: "Todo #23: stage the rebuy hotfix IDs" },
    ]),
    "Todo #23: stage the rebuy hotfix IDs",
  )
})

test("task continuation stops only when complete or every remainder is blocked", () => {
  assert.match(
    taskContinuationMessage({
      pending: ["#2 Fix release"],
      blocked: [],
      completed: [],
    }) ?? "",
    /continue working/i,
  )
  assert.equal(
    taskContinuationMessage({
      pending: [],
      blocked: ["#3 Deploy — no access"],
      completed: [],
    }),
    undefined,
  )
  assert.equal(
    taskContinuationMessage({ pending: [], blocked: [], completed: [] }),
    undefined,
  )
})

test("legacy loop migration recovers only the latest still-active independent goal", () => {
  const businessGoal = {
    ...active,
    condition: "Complete the full v1 and v2 buildout",
  } as const
  const legacyLoop = {
    ...active,
    condition: "15m /reload latest config",
    startedAt: 2,
  } as const
  assert.deepEqual(
    recoverLatestIndependentGoal([businessGoal, legacyLoop], condition =>
      condition.includes("/reload"),
    ),
    businessGoal,
  )
  assert.deepEqual(
    recoverLatestIndependentGoal(
      [
        businessGoal,
        legacyLoop,
        {
          status: "cleared",
          condition: legacyLoop.condition,
          startedAt: legacyLoop.startedAt,
          finishedAt: 3,
          turns: 0,
          tokens: 0,
          lastReason:
            "Migrated from the legacy /loop goal into an infinite recurring loop.",
        },
      ],
      condition => condition.includes("/reload"),
    ),
    businessGoal,
  )
  assert.equal(
    recoverLatestIndependentGoal(
      [
        businessGoal,
        {
          status: "cleared",
          condition: businessGoal.condition,
          startedAt: businessGoal.startedAt,
          finishedAt: 3,
          turns: 1,
          tokens: 10,
          lastReason: "done",
        },
        legacyLoop,
      ],
      condition => condition.includes("/reload"),
    ),
    undefined,
  )
})

test("met goals become achieved and invalid evaluations keep the goal active", () => {
  const achieved = applyGoalEvaluation(
    active,
    { status: "valid", met: true, reason: "verified" },
    50,
    2_000,
  )
  assert.deepEqual(achieved, {
    status: "achieved",
    condition: active.condition,
    startedAt: active.startedAt,
    finishedAt: 2_000,
    turns: 3,
    tokens: 350,
    lastReason: "verified",
  })

  const stillActive = applyGoalEvaluation(
    active,
    { status: "invalid", reason: "evaluator unavailable" },
    0,
    2_000,
  )
  assert.equal(stillActive.status, "active")
  assert.equal(
    stillActive.lastReason,
    "evaluator unavailable Continuing until a valid check completes.",
  )
})

test("active and legacy paused goals restore while terminal goals stay terminal", () => {
  assert.deepEqual(restoreGoal(active, 5_000), {
    status: "active",
    condition: active.condition,
    startedAt: 5_000,
    turns: 0,
    tokens: 0,
  })

  assert.deepEqual(
    restoreGoal(
      {
        status: "paused",
        condition: active.condition,
        startedAt: 1_000,
        finishedAt: 2_000,
        turns: 3,
        tokens: 350,
        lastReason: "old evaluator outage",
      },
      5_000,
    ),
    {
      status: "active",
      condition: active.condition,
      startedAt: 5_000,
      turns: 0,
      tokens: 0,
      lastReason: "Restored from paused legacy state: old evaluator outage",
    },
  )

  const achieved = applyGoalEvaluation(
    active,
    { status: "valid", met: true, reason: "done" },
    1,
    2_000,
  )
  assert.deepEqual(restoreGoal(achieved, 5_000), achieved)
})

test("goal status reports condition, elapsed time, turns, tokens, and reason", () => {
  assert.equal(
    formatGoalStatus(undefined, 2_000),
    "No goal has been set in this session.",
  )
  const status = formatGoalStatus(active, 61_000)
  assert.match(status, /all routing tests pass/)
  assert.match(status, /1m/)
  assert.match(status, /2 turns/)
  assert.match(status, /300 tokens/)
  assert.match(status, /one test still fails/)
})

test("stored goals reject malformed session data", () => {
  assert.deepEqual(parseStoredGoal(active), active)
  assert.equal(parseStoredGoal({ ...active, turns: -1 }), undefined)
  assert.equal(parseStoredGoal({ ...active, status: "unknown" }), undefined)
  assert.equal(parseStoredGoal("active"), undefined)
})

test("goal evaluator prompt treats the transcript as untrusted evidence", () => {
  const prompt = buildGoalEvaluatorPrompt("tests pass", [
    "user: run tests",
    "assistant: all pass",
  ])
  assert.match(prompt, /tests pass/)
  assert.match(prompt, /untrusted evidence/i)
  assert.match(prompt, /assistant: all pass/)
  assert.match(prompt, /return only/i)
})

test("assistant usage counts only valid non-negative totals", () => {
  assert.equal(
    assistantUsageTokens([
      { role: "assistant", usage: { totalTokens: 12 } },
      { role: "user", usage: { totalTokens: 99 } },
      { role: "assistant", usage: { totalTokens: -1 } },
      { role: "assistant", usage: {} },
    ]),
    12,
  )
})
