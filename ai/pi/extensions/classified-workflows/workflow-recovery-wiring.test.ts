import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

const extensionSource = readFileSync(
  new URL("./index.ts", import.meta.url),
  "utf8",
)

test("shutdown retires workflow callbacks before touching or aborting contexts", () => {
  const start = extensionSource.indexOf('pi.on("session_shutdown"')
  assert.ok(start >= 0)
  const shutdown = extensionSource.slice(
    start,
    extensionSource.indexOf('pi.on("agent_start"', start),
  )
  assert.match(shutdown, /workflowLifecycleActive = false/)
  assert.match(shutdown, /latestCtx = undefined/)
  const render = extensionSource.slice(
    extensionSource.indexOf("const renderWorkflowPanel"),
    extensionSource.indexOf("const showWorkflowMessage"),
  )
  assert.ok(
    render.indexOf("if (!workflowLifecycleActive)") <
      render.indexOf("ctx?.hasUI"),
  )
  assert.match(
    extensionSource,
    /\.then\(result => \{\s*if \(!workflowLifecycleActive\) return/,
  )
  assert.match(
    extensionSource,
    /\.catch\(error => \{\s*if \(!workflowLifecycleActive\) return/,
  )
})

test("provider-infeasible budgets fail before foreground or background workflow launch", () => {
  const tool = extensionSource.indexOf('name: "workflow"')
  const execute = extensionSource.indexOf("async execute(", tool)
  const preflight = extensionSource.indexOf(
    "assertExecutableWorkflowBudget(limits.tokenBudget, limits.maxAgents)",
    execute,
  )
  const background = extensionSource.indexOf("if (params.background)", execute)
  const foreground = extensionSource.indexOf(
    "refreshWorkflowAudits(ctx)",
    execute,
  )
  assert.ok(tool >= 0)
  assert.ok(execute > tool)
  assert.ok(preflight > execute)
  assert.ok(background > preflight)
  assert.ok(foreground > preflight)
})

test("background workflows persist a running snapshot before their process starts", () => {
  const start = extensionSource.indexOf("const startBackgroundWorkflow")
  const persisted = extensionSource.indexOf(
    "startWorkflowRun(workflowRuntime",
    start,
  )
  const executed = extensionSource.indexOf("void runWorkflowScript(", start)
  assert.ok(start >= 0)
  assert.ok(persisted > start)
  assert.ok(executed > persisted)
})

test("background checkpoints abort through the owned controller without throwing", () => {
  const start = extensionSource.indexOf("const startBackgroundWorkflow")
  const checkpoint = extensionSource.slice(
    extensionSource.indexOf("checkpoint: async message =>", start),
    extensionSource.indexOf("phase: title =>", start),
  )
  assert.match(checkpoint, /workflow\.controller\.abort\(error\)/)
  assert.match(checkpoint, /return "approved"/)
  assert.doesNotMatch(checkpoint, /throw new Error/)
})

test("foreground checkpoints continue without exposing workflow mechanics to the user", () => {
  const tool = extensionSource.indexOf('name: "workflow"')
  const checkpoint = extensionSource.slice(
    extensionSource.indexOf("checkpoint: async message =>", tool),
    extensionSource.indexOf("phase: title =>", tool),
  )
  assert.doesNotMatch(
    extensionSource,
    /ctx\.ui\.confirm\("Workflow checkpoint"/,
  )
  assert.match(checkpoint, /if \(detachedWorkflow\)/)
  assert.match(checkpoint, /return "approved"/)
  assert.doesNotMatch(
    extensionSource,
    /Use agent\(\), parallel\(\), and checkpoint\(\)/,
  )
})

test("startup and managed reload restore interrupted background workflows", () => {
  assert.match(
    extensionSource,
    /workflowRuntime = restoreWorkflowRuntimeState\(branch\)[\s\S]*?event\.reason === "startup" \|\| event\.reason === "reload"[\s\S]*?recoverInterruptedBackgroundWorkflows\(ctx\)/,
  )
  assert.match(
    extensionSource,
    /markWorkflowRunRecovered\(workflowRuntime, run\.id,[\s\S]*?startBackgroundWorkflow\([\s\S]*?\{ recoveredRun \}/,
  )
})

test("recovered workflows fail closed before mutation-capable child replay", () => {
  assert.match(
    extensionSource,
    /return recoveredRun[\s\S]*?prepared\.pipe\(Effect\.flatMap\(readOnlyRecoveryRequest\)\)[\s\S]*?: prepared/,
  )
})

test("managed reload keeps a recoverable running snapshot while explicit cancellation is terminal", () => {
  assert.match(
    extensionSource,
    /if \(workflow\.error !== MANAGED_RELOAD_WORKFLOW_CANCELLATION\) \{[\s\S]*?finishPersistedWorkflow/,
  )
  assert.match(
    extensionSource,
    /finishPersistedWorkflow\(id, "cancelled", workflow\.finishedAt\)[\s\S]*?Cancelled by user/,
  )
})
