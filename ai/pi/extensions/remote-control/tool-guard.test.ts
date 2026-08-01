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
    /pi\.on\("agent_settled"[\s\S]*?if \(turn\) await finishFailure\(turn, "model_error"\)/,
  );
});

test("successful remote replies trigger one source-fixed semantic routing continuation", () => {
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
