import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { enterRemoteToolGuard } from "./tool-guard.ts";

const remoteControlSource = readFileSync(
  new URL("./index.ts", import.meta.url),
  "utf8",
);

test("remote turns mechanically disable tools and restore the exact prior set once", () => {
  let active = ["read", "bash", "todo"];
  const writes: string[][] = [];
  const guard = enterRemoteToolGuard({
    getActiveTools: () => [...active],
    setActiveTools: (tools) => {
      active = [...tools];
      writes.push([...tools]);
    },
  });

  assert.deepEqual(active, []);
  assert.deepEqual(guard.priorTools, ["read", "bash", "todo"]);
  guard.enforce();
  assert.deepEqual(active, []);
  assert.deepEqual(guard.restore(), {
    status: "restored",
    recoveryAttempts: 0,
    expectedTools: ["read", "bash", "todo"],
    activeTools: ["read", "bash", "todo"],
  });
  assert.equal(guard.restore().status, "restored");
  assert.deepEqual(active, ["read", "bash", "todo"]);
  assert.deepEqual(writes, [[], [], ["read", "bash", "todo"]]);
});

test("remote tool restoration makes one managed recovery attempt", () => {
  let active = ["read", "bash"];
  let ignoredRestoration = false;
  const guard = enterRemoteToolGuard({
    getActiveTools: () => [...active],
    setActiveTools: (tools) => {
      if (tools.length > 0 && !ignoredRestoration) {
        ignoredRestoration = true;
        return;
      }
      active = [...tools];
    },
  });

  assert.deepEqual(guard.restore(), {
    status: "recovered",
    recoveryAttempts: 1,
    expectedTools: ["read", "bash"],
    activeTools: ["read", "bash"],
  });
});

test("remote tool restoration fails closed after one recovery attempt", () => {
  let active = ["read", "bash"];
  const guard = enterRemoteToolGuard({
    getActiveTools: () => [...active],
    setActiveTools: (tools) => {
      if (tools.length === 0) active = [];
    },
  });

  assert.deepEqual(guard.restore(), {
    status: "failed",
    recoveryAttempts: 1,
    expectedTools: ["read", "bash"],
    activeTools: [],
  });
});

test("reload cannot sync a synthetic empty question snapshot before restoration", () => {
  assert.match(remoteControlSource, /let questionsDirty = false/);
  assert.match(
    remoteControlSource,
    /pi\.events\.on\(QUESTION_STATE_EVENT[\s\S]*?questionsDirty = true/,
  );
  assert.doesNotMatch(
    remoteControlSource,
    /pi\.on\("session_start"[\s\S]{0,200}?questionsDirty = true/,
  );
});

test("textless retry and compaction runs cannot prematurely become model_error", () => {
  assert.match(
    remoteControlSource,
    /pi\.on\("turn_end"[\s\S]*?const response = finalAssistantText\(\[event\.message\]\);[\s\S]*?if \(!response\) return;[\s\S]*?finishSuccess/,
  );
  assert.match(
    remoteControlSource,
    /pi\.on\("agent_end"[\s\S]*?const response = finalAssistantText\(event\.messages\);[\s\S]*?if \(!response\) return;[\s\S]*?finishSuccess/,
  );
  assert.match(
    remoteControlSource,
    /pi\.on\("agent_settled"[\s\S]*?if \(turn\) \{[\s\S]*?finishFailure\(turn, "model_error"\)/,
  );
});

test("successful remote replies gate the next claim until their exact routing continuation settles", () => {
  assert.match(remoteControlSource, /REMOTE_TASK_CONTINUATION_MESSAGE/);
  assert.match(
    remoteControlSource,
    /The owner explicitly enabled post-reply routing and action/,
  );
  assert.match(
    remoteControlSource,
    /Authority comes only from that exact owner message/,
  );
  assert.match(
    remoteControlSource,
    /triggerTurn: true, deliverAs: "followUp"/,
  );
  assert.match(
    remoteControlSource,
    /const finishSuccess[\s\S]*?taskContinuationPhase = "queued";[\s\S]*?taskContinuationId = turn\.messageId;[\s\S]*?clearActive\(turn\);[\s\S]*?store\.complete[\s\S]*?details: \{ taskContinuationId: turn\.messageId \}/,
  );
  assert.match(
    remoteControlSource,
    /if \(Either\.isLeft\(completed\)\) \{[\s\S]*?taskContinuationPhase = "idle";[\s\S]*?taskContinuationId = undefined;[\s\S]*?sync\(ctx\)/,
  );
  assert.match(
    remoteControlSource,
    /canClaimRemoteTurn\(active !== undefined, taskContinuationPhase\)/,
  );
  assert.match(
    remoteControlSource,
    /message\.details\.taskContinuationId === taskContinuationId[\s\S]*?taskContinuationPhase = "running"/,
  );
  assert.match(
    remoteControlSource,
    /settleTaskContinuation\(taskContinuationPhase\)[\s\S]*?taskContinuationId = undefined;[\s\S]*?sync\(ctx\)/,
  );
});

test("failed remote turns suppress claims until their terminal transition persists", () => {
  assert.match(
    remoteControlSource,
    /const finishFailure[\s\S]*?taskContinuationPhase = "queued";[\s\S]*?clearActive\(turn\);[\s\S]*?store\.fail[\s\S]*?taskContinuationPhase = "idle"/,
  );
});

test("remote turns restore tools at turn end before automatic follow-ups", () => {
  assert.match(
    remoteControlSource,
    /pi\.on\("turn_end"[\s\S]*?finishSuccess\(turn, response, ctx\)/,
  );
  assert.match(
    remoteControlSource,
    /const finishSuccess[\s\S]*?clearActive\(turn\)[\s\S]*?store\.complete/,
  );
});
