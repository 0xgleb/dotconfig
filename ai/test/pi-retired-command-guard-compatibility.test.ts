import assert from "node:assert/strict"
import test from "node:test"
import * as context from "../pi/extensions/classified-workflows/project-context.ts"

test("already-loaded callers retain the retired command guard as a non-enforcing callable", () => {
  const guard: unknown = Reflect.get(
    context,
    "unsafeRuntimeCommandLocationBlockReason",
  )
  assert.ok(typeof guard === "function")
  for (const command of [
    "git status --short\ngit diff --stat",
    "cd /repo\ngit status --short",
    "git commit --only -m cleanup -- selected.ts",
  ]) {
    assert.equal(
      guard({ toolName: "bash", input: { command }, cwd: "/repo" }),
      undefined,
    )
    assert.equal(guard("bash", { command }, { cwd: "/repo" }), undefined)
  }
})
