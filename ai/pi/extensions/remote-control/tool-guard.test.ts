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
