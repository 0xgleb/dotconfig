import assert from "node:assert/strict"
import test from "node:test"
import { enterRemoteToolGuard } from "./tool-guard.ts"

const fixture = (prior: readonly string[]) => {
  let active = [...prior]
  return {
    controller: {
      getActiveTools: () => [...active],
      setActiveTools: (tools: string[]) => {
        active = [...tools]
      },
    },
    tools: () => [...active],
  }
}

test("management retains existing owner reporting through enforcement and exact restoration", () => {
  const prior = ["bash", "report_owner", "read", "todo", "workflow"]
  const f = fixture(prior)
  const guard = enterRemoteToolGuard(f.controller, "management")
  assert.deepEqual(f.tools(), ["report_owner", "read", "todo"])
  f.controller.setActiveTools(["bash", "workflow"])
  guard.enforce()
  assert.deepEqual(f.tools(), ["report_owner", "read", "todo"])
  assert.equal(guard.restore().status, "restored")
  assert.deepEqual(f.tools(), prior)
})

test("ordinary agent communication cannot report or execute and restores the exact tools", () => {
  const prior = ["report_owner", "bash", "read", "todo"]
  const f = fixture(prior)
  const guard = enterRemoteToolGuard(f.controller, "communication")
  assert.deepEqual(f.tools(), [])
  guard.enforce()
  assert.deepEqual(f.tools(), [])
  guard.restore()
  assert.deepEqual(f.tools(), prior)
})

test("management cannot promote unavailable owner reporting", () => {
  const f = fixture(["bash", "read", "todo"])
  const guard = enterRemoteToolGuard(f.controller, "management")
  assert.deepEqual(f.tools(), ["read", "todo"])
  guard.enforce()
  assert.deepEqual(f.tools(), ["read", "todo"])
  guard.restore()
  assert.deepEqual(f.tools(), ["bash", "read", "todo"])
})
