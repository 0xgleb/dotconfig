import assert from "node:assert/strict";
import test from "node:test";
import { executeWithContextCwd } from "./contextual-tool.ts";

test("tool execution uses the current extension context cwd", async () => {
  const observed: string[] = [];
  const createTool = (cwd: string) => ({
    async execute(value: string) {
      observed.push(cwd);
      return `${cwd}/${value}`;
    },
  });

  assert.equal(await executeWithContextCwd("/first", createTool, ["file"]), "/first/file");
  assert.equal(await executeWithContextCwd("/second", createTool, ["file"]), "/second/file");
  assert.deepEqual(observed, ["/first", "/second"]);
});
