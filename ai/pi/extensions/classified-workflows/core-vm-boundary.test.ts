import assert from "node:assert/strict"
import test from "node:test"
import {
  runWorkflowScript,
  type WorkflowDependencies,
  type WorkflowLimits,
} from "./core.ts"

const limits: WorkflowLimits = {
  maxAgents: 1,
  concurrency: 1,
  agentTimeoutMs: 1_000,
  workflowTimeoutMs: 5_000,
  retries: 0,
  tokenBudget: 4_000,
}
const dependencies: WorkflowDependencies = {
  availableMemoryBytes: () => Number.MAX_SAFE_INTEGER,
  runAgent: async () => ({
    status: "completed",
    output: "fixture",
    usageTokens: 0,
  }),
  checkpoint: async () => "approved",
}

test("bridge handles are absent from the workflow globals", async () => {
  assert.deepEqual(
    await runWorkflowScript(
      "return [typeof __workflowAsyncBridge, typeof __workflowSyncBridge];",
      limits,
      dependencies,
    ),
    ["undefined", "undefined"],
  )
})

for (const probe of [
  'const pending = agent("fixture"); return pending.constructor.constructor("return 42")();',
  'const pending = agent("fixture"); return pending.then.constructor("return 42")();',
  'const result = await agent("fixture"); return result.constructor.constructor("return 42")();',
  'try { await agent({}); } catch (error) { return error.constructor.constructor("return 42")(); }',
])
  test("promises, results and rejection errors remain in the workflow realm", async () => {
    await assert.rejects(
      runWorkflowScript(probe, limits, dependencies),
      /code generation|Code generation|EvalError/,
    )
  })

test("approved checkpoints do not consult poisoned result prototypes or hang", async () => {
  const result = await runWorkflowScript(
    'Object.defineProperty(Object.prototype, "value", { get() { throw new Error("fixture getter"); } }); await checkpoint("fixture"); return "done";',
    limits,
    dependencies,
  )
  assert.equal(result, "done")
})

test("Promise assimilation callbacks do not enable host string compilation", async () => {
  await assert.rejects(
    runWorkflowScript(
      'Promise.prototype.then = function (resolve) { resolve(resolve.constructor("return 42")()); }; return null;',
      limits,
      dependencies,
    ),
    /code generation|Code generation|EvalError/,
  )
})

test("the public structured-clone return contract is unchanged", async () => {
  const result = await runWorkflowScript(
    'const cycle = {}; cycle.self = cycle; return { big: 7n, map: new Map([["key", 1]]), set: new Set([2]), cycle, omitted: undefined };',
    limits,
    dependencies,
  )
  const cycle: { self?: unknown } = {}
  cycle.self = cycle
  assert.deepEqual(result, {
    big: 7n,
    map: new Map([["key", 1]]),
    set: new Set([2]),
    cycle,
    omitted: undefined,
  })
})

for (const hook of ["agent", "parallel", "checkpoint", "phase", "log"])
  test(`${hook} cannot compile strings through a host constructor`, async () => {
    // A constant-only probe: no files, processes, environment, network or tools.
    await assert.rejects(
      runWorkflowScript(
        `return await ${hook}.constructor("return 42")();`,
        limits,
        dependencies,
      ),
      /code generation|Code generation|EvalError/,
    )
  })
