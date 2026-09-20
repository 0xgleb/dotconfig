import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { stripTypeScriptTypes } from "node:module"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import test from "node:test"
import * as legacy from "./core.ts"
import * as engine from "./workflow-engine.ts"

const consumer = `
import assert from "node:assert/strict";
import { Effect, Either } from "effect";
import * as engine from "./classified-workflows/workflow-engine.js";
for (const dependency of ["@earendil-works/pi-coding-agent", "@earendil-works/pi-ai"]) {
  assert.throws(() => import.meta.resolve(dependency), { code: "ERR_MODULE_NOT_FOUND" });
}
assert.equal("deterministicDecision" in engine, false);
const limits = {maxAgents: 1, concurrency: 1, agentTimeoutMs: 1000,
  workflowTimeoutMs: 2000, retries: 0, tokenBudget: 8000};
let calls = 0;
const dependencies = {
  availableMemoryBytes: () => 64 * 1024 ** 3,
  checkpoint: async () => "denied",
  runAgent: async request => {
    calls++;
    assert.deepEqual(request.tools, ["read"]);
    return {status: "completed", output: request.task, usageTokens: 5};
  },
};
assert.deepEqual(await engine.runWorkflowScript(
  'return await agent("portable", {tools: "read"});', limits, dependencies),
  {status: "completed", output: "portable", usageTokens: 5});
assert.equal(calls, 1);
await assert.rejects(engine.runWorkflowScript(
  'await checkpoint("synthetic gate");', limits, dependencies), /Checkpoint denied/);
await assert.rejects(engine.runWorkflowScript(
  'return await agent("invalid", {tools: []});', limits, dependencies), /non-empty array/);
assert.equal(calls, 1);
const malformed = Effect.runSync(Effect.either(engine.normalizeAgentTools([])));
assert.ok(Either.isLeft(malformed));
assert.equal(malformed.left._tag, "WorkflowScriptError");
console.log("portable workflow behavior verified");
`

test("legacy core preserves every portable engine runtime export identity", () => {
  for (const [name, value] of Object.entries(engine))
    assert.equal(Reflect.get(legacy, name), value, name)
})

test("emitted workflow engine runs without local policy or Pi host modules", async () => {
  const extensions = new URL("../", import.meta.url)
  const root = fileURLToPath(
    new URL("../../../../.tmp/metagenda-engine/tests/", import.meta.url),
  )
  await mkdir(root, { recursive: true })
  const fixture = await mkdtemp(join(root, "consumer-"))
  try {
    await mkdir(join(fixture, "node_modules"))
    await symlink(
      fileURLToPath(new URL("node_modules/effect", extensions)),
      join(fixture, "node_modules/effect"),
      "dir",
    )
    await writeFile(
      join(fixture, "package.json"),
      '{"type":"module","private":true}\n',
    )
    for (const name of [
      "classified-workflows/workflow-engine",
      "shared/memory-capacity",
    ]) {
      const source = readFileSync(new URL(`${name}.ts`, extensions), "utf8")
      const compiled = stripTypeScriptTypes(source).replace(
        /((?:\.\.\/|\.\/)[^"\n]+)\.ts"/gu,
        '$1.js"',
      )
      const directory = name.startsWith("classified-workflows/")
        ? "classified-workflows"
        : "shared"
      await mkdir(join(fixture, directory), { recursive: true })
      await writeFile(join(fixture, `${name}.js`), compiled)
    }
    await writeFile(join(fixture, "consumer.mjs"), consumer)
    const result = spawnSync(
      process.execPath,
      [join(fixture, "consumer.mjs")],
      { cwd: fixture, encoding: "utf8", timeout: 10000 },
    )
    assert.equal(result.error, undefined)
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /portable workflow behavior verified/u)
  } finally {
    await rm(fixture, { recursive: true, force: true })
  }
})
