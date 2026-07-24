import assert from "node:assert/strict";
import test from "node:test";
import { enterRemoteToolGuard } from "./tool-guard.ts";

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
  guard.restore();
  guard.restore();
  assert.deepEqual(active, ["read", "bash", "todo"]);
  assert.deepEqual(writes, [[], [], ["read", "bash", "todo"]]);
});
