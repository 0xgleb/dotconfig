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
  const prior = ["bash", "report_owner", "read", "task", "workflow"]
  const f = fixture(prior)
  const guard = enterRemoteToolGuard(f.controller, "management")
  assert.deepEqual(f.tools(), [
    "bash",
    "report_owner",
    "read",
    "task",
    "workflow",
  ])
  f.controller.setActiveTools(["bash", "workflow"])
  guard.enforce()
  assert.deepEqual(f.tools(), [
    "bash",
    "report_owner",
    "read",
    "task",
    "workflow",
  ])
  assert.equal(guard.restore().status, "restored")
  assert.deepEqual(f.tools(), prior)
})

test("management preserves available workflow without operational-worker tools", () => {
  const prior = ["workflow", "read", "agent_workspace"]
  const f = fixture(prior)
  const guard = enterRemoteToolGuard(f.controller, "management")

  assert.deepEqual(f.tools(), ["workflow", "read"])
  f.controller.setActiveTools(["agent_workspace"])
  guard.enforce()
  assert.deepEqual(f.tools(), ["workflow", "read"])
  guard.restore()
  assert.deepEqual(f.tools(), prior)
})

test("management preserves available file tools without exposing them to ordinary communication", () => {
  const prior = ["write", "edit", "read", "workflow"]
  const f = fixture(prior)
  const guard = enterRemoteToolGuard(f.controller, "management")

  assert.deepEqual(f.tools(), ["write", "edit", "read", "workflow"])
  f.controller.setActiveTools(["workflow"])
  guard.enforce()
  assert.deepEqual(f.tools(), ["write", "edit", "read", "workflow"])
  guard.restore()
  assert.deepEqual(f.tools(), prior)

  const communication = enterRemoteToolGuard(f.controller, "communication")

  assert.deepEqual(f.tools(), [])
  communication.restore()
  assert.deepEqual(f.tools(), prior)
})

test("ordinary agent communication cannot report or execute and restores the exact tools", () => {
  const prior = ["report_owner", "bash", "read", "task"]
  const f = fixture(prior)
  const guard = enterRemoteToolGuard(f.controller, "communication")
  assert.deepEqual(f.tools(), [])
  guard.enforce()
  assert.deepEqual(f.tools(), [])
  guard.restore()
  assert.deepEqual(f.tools(), prior)
})

test("management cannot promote unavailable owner reporting", () => {
  const f = fixture(["bash", "read", "task"])
  const guard = enterRemoteToolGuard(f.controller, "management")
  assert.deepEqual(f.tools(), ["bash", "read", "task"])
  guard.enforce()
  assert.deepEqual(f.tools(), ["bash", "read", "task"])
  guard.restore()
  assert.deepEqual(f.tools(), ["bash", "read", "task"])
})

test("management cannot promote unavailable GitHub CLI, file or workflow tools", () => {
  const prior = ["read", "report_owner", "agent_workspace"]
  const f = fixture(prior)
  const guard = enterRemoteToolGuard(f.controller, "management")

  assert.deepEqual(f.tools(), ["read", "report_owner"])
  guard.enforce()
  assert.deepEqual(f.tools(), ["read", "report_owner"])
  guard.restore()
  assert.deepEqual(f.tools(), prior)
})
