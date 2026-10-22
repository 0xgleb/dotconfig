import assert from "node:assert/strict"
import test from "node:test"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { getPackageDir } from "@earendil-works/pi-coding-agent"
import { Either } from "effect"
import {
  managerSessionLaunchPlan,
  globalManagerSessionLaunchPlan,
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

test("all workers open one global native manager with no worker-pair startup flag", async () => {
  const first = globalManagerSessionLaunchPlan(input)
  const other = globalManagerSessionLaunchPlan({
    ...input,
    workerSessionId: "second-worker",
    workerCwd: "/projects/another",
  })
  assert.ok(Either.isRight(first))
  assert.ok(Either.isRight(other))
  assert.deepEqual(first, other)
  assert.equal(first.right.kind, "launch")
  if (first.right.kind !== "launch") assert.fail("Expected global launch")
  const plan = first.right
  assert.equal(plan.paneName, "manager")
  assert.equal(plan.sessionDirectory, "/state/pi/agent/manager/global/sessions")
  assert.equal(plan.args[5], "/state/pi/agent/manager/global")
  assert.ok(!plan.args.includes("--manager-worker"))
  assert.ok(plan.args.slice(0, plan.args.indexOf("--")).includes("--floating"))
  assert.ok(!plan.args.includes("--no-extensions"))
  const { parseArgs } = await import(
    pathToFileURL(join(getPackageDir(), "dist", "cli", "args.js")).href
  )
  const parsed = parseArgs(plan.args.slice(plan.args.indexOf("--") + 2))
  assert.deepEqual(parsed.diagnostics, [])
  assert.deepEqual(parsed.messages, [])
  assert.equal(parsed.unknownFlags.get("manager"), true)
})

test("an existing global manager is reused regardless of the requesting worker", () => {
  const result = globalManagerSessionLaunchPlan({
    ...input,
    workerSessionId: "second-worker",
    workerCwd: "/other",
    existingPaneNames: ["manager"],
  })
  assert.ok(Either.isRight(result))
  assert.deepEqual(result.right, { kind: "existing", paneName: "manager" })
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
    assert.ok(
      Either.isLeft(globalManagerSessionLaunchPlan({ ...input, ...patch })),
    )
  }
})
