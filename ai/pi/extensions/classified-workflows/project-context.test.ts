import assert from "node:assert/strict";
import test from "node:test";
import { describeRuntimeProjectContext } from "./project-context.ts";

test("runtime project context identifies repository roots and descendants", () => {
  assert.deepEqual(
    describeRuntimeProjectContext("/workspace/st0x", "/workspace/st0x"),
    {
      cwd: "/workspace/st0x",
      gitToplevel: "/workspace/st0x",
      cwdRelation: "repository-root",
    },
  );
  assert.deepEqual(
    describeRuntimeProjectContext("/workspace/st0x/crate", "/workspace/st0x"),
    {
      cwd: "/workspace/st0x/crate",
      gitToplevel: "/workspace/st0x",
      cwdRelation: "inside-repository",
    },
  );
});

test("runtime project context does not invent a repository boundary", () => {
  assert.deepEqual(describeRuntimeProjectContext("/workspace", undefined), {
    cwd: "/workspace",
    cwdRelation: "outside-repository",
  });
});
