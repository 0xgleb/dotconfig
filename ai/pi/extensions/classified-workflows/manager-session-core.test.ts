import assert from "node:assert/strict"
import test from "node:test"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { getPackageDir } from "@earendil-works/pi-coding-agent"
import { Either } from "effect"
import {
  managerSessionLaunchPlan,
  type ManagerSessionLaunchInput,
} from "./manager-session-core.ts"

const input: ManagerSessionLaunchInput = {
  workerSessionId: "worker-session-123",
  workerCwd: "/projects/current-worker",
  agentDir: "/state/pi/agent",
  piExecutable: "/state/pi/agent/bin/pi",
  provider: "openai-codex",
  modelId: "gpt-6.1-sol",
  existingPaneNames: [],
}

const launch = () => {
  const result = managerSessionLaunchPlan(input)
  assert.ok(Either.isRight(result))
  assert.equal(result.right.kind, "launch")
  if (result.right.kind !== "launch") assert.fail("Expected native launch")
  return result.right
}

test("native manager launch uses the ordinary Pi frontend and configured extensions", () => {
  const plan = launch()
  assert.equal(plan.executable, "zellij")
  assert.deepEqual(plan.args.slice(0, 7), [
    "action",
    "new-pane",
    "--name",
    plan.paneName,
    "--cwd",
    input.workerCwd,
    "--",
  ])
  assert.equal(plan.args[7], input.piExecutable)
  assert.ok(!plan.args.includes("--no-extensions"))
  assert.ok(!plan.args.includes("--no-themes"))
  assert.ok(!plan.args.includes("--no-session"))
  assert.ok(!plan.args.includes("--print"))
  assert.ok(!plan.args.includes("--mode"))
  assert.ok(plan.args.includes("--continue"))
  assert.ok(plan.args.includes("--no-builtin-tools"))
})

test("native Pi's actual CLI parser accepts the launch flags without a startup model turn", async () => {
  const plan = launch()
  const moduleUrl = pathToFileURL(
    join(getPackageDir(), "dist", "cli", "args.js"),
  )
  const { parseArgs } = await import(moduleUrl.href)
  const parsed = parseArgs(plan.args.slice(8))

  assert.deepEqual(parsed.diagnostics, [])
  assert.deepEqual(parsed.messages, [])
  assert.equal(parsed.sessionDir, plan.sessionDirectory)
  assert.equal(parsed.continue, true)
  assert.equal(parsed.noBuiltinTools, true)
  assert.equal(parsed.noExtensions, undefined)
  assert.equal(parsed.model, "openai-codex/gpt-6.1-sol")
  assert.equal(parsed.unknownFlags.get("manager-worker"), input.workerSessionId)
})

test("reopening an existing manager does not launch a duplicate session", () => {
  const first = launch()
  const reopened = managerSessionLaunchPlan({
    ...input,
    existingPaneNames: [first.paneName],
  })
  assert.ok(Either.isRight(reopened))
  assert.deepEqual(reopened.right, {
    kind: "existing",
    paneName: first.paneName,
  })
})

test("native manager sessions are stable per worker and isolated between workers", () => {
  const first = launch()
  const same = managerSessionLaunchPlan(input)
  const other = managerSessionLaunchPlan({
    ...input,
    workerSessionId: "other-worker",
  })
  assert.deepEqual(same, Either.right(first))
  assert.ok(Either.isRight(other))
  assert.equal(other.right.kind, "launch")
  if (other.right.kind !== "launch")
    assert.fail("Expected second worker launch")
  assert.notEqual(other.right.sessionDirectory, first.sessionDirectory)
  assert.notEqual(other.right.paneName, first.paneName)
})

test("invalid worker identity, workspace and model cannot reach a native launch", () => {
  for (const patch of [
    { workerSessionId: "../another-session" },
    { workerSessionId: "worker\nnew-command" },
    { workerCwd: "relative/workspace" },
    { agentDir: "relative/state" },
    { piExecutable: "pi" },
    { provider: "" },
    { modelId: "" },
    { modelId: "model\nsecond-input" },
    { provider: "anthropic", modelId: "claude" },
  ]) {
    assert.ok(Either.isLeft(managerSessionLaunchPlan({ ...input, ...patch })))
  }
})
