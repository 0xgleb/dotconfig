import assert from "node:assert/strict"
import test, { type TestContext } from "node:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { Effect } from "effect"
import { InMemoryCredentialStore } from "@earendil-works/pi-ai"
import {
  createEventBus,
  createExtensionRuntime,
  ExtensionRunner,
  getPackageDir,
  ModelRegistry,
  ModelRuntime,
  SessionManager,
  type Extension,
  type ExtensionError,
} from "@earendil-works/pi-coding-agent"
import registryExtension from "./index.ts"
import { makeSqliteRegistryStore } from "./sqlite-store.ts"
import { registryStateRoot } from "./paths.ts"

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

test("registered SDK handler returns exact stored selectors and translates budget failures without partial data", async (t: TestContext) => {
  const root = mkdtempSync(join(tmpdir(), "registry-selection-handler-"))
  const packageRoot = getPackageDir()
  const loader = await import(
    pathToFileURL(join(packageRoot, "dist", "core", "extensions", "loader.js"))
      .href
  )
  const runtime = createExtensionRuntime()
  const modelRegistry = new ModelRegistry(
    await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(),
      modelsPath: null,
      allowModelNetwork: false,
      refreshOnCreate: false,
    }),
  )
  let extension: Extension
  // index.ts reads this documented non-secret path key only when constructing its store.
  // Node runs this file in its own process; restore it before executing the handler.
  const previous = process.env.XDG_STATE_HOME
  process.env.XDG_STATE_HOME = root
  try {
    extension = await loader.loadExtensionFromFactory(
      registryExtension,
      process.cwd(),
      createEventBus(),
      runtime,
      "registry-selection-execute.test",
    )
  } finally {
    if (previous === undefined) delete process.env.XDG_STATE_HOME
    else process.env.XDG_STATE_HOME = previous
  }
  const runner = new ExtensionRunner(
    [extension],
    runtime,
    "/project",
    SessionManager.inMemory("/project", { id: "manager-session" }),
    modelRegistry,
  )
  const extensionErrors: ExtensionError[] = []
  runner.onError(error => extensionErrors.push(error))
  const producer = makeSqliteRegistryStore(registryStateRoot(root, root))
  t.after(async () => {
    try {
      producer.close()
      await runner.emit({ type: "session_shutdown", reason: "reload" })
      assert.deepEqual(extensionErrors, [])
    } finally {
      rmSync(root, { recursive: true })
    }
  })
  const now = Date.now()
  const session = "00000000-0000-4000-8000-000000000001"
  const identity = { id: `${session}:pid:123`, pid: 123 }
  const usage = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
  }
  await Effect.runPromise(
    producer.heartbeatAgent({
      agent: identity,
      cwd: "/project",
      label: "worker",
      usage,
      now,
      ttlMs: 60000,
    }),
  )
  const registered = extension.tools.get("agent_registry")
  assert.ok(registered, "actual registered registry tool missing")
  assert.strictEqual(registered.sourceInfo, extension.sourceInfo)
  const tool = registered.definition
  const ctx = runner.createToolContext("selectable-list", undefined)
  assert.equal(ctx.sessionManager.getSessionId(), "manager-session")
  assert.deepEqual(ctx.tools, [])
  const nestedFailure = await ctx.executeTool("unregistered-test-tool", {})
  assert.equal(nestedFailure.isError, true)
  assert.equal(nestedFailure.toolCall.id, "selectable-list/0")
  assert.deepEqual(nestedFailure.result.content, [
    {
      type: "text",
      text: "Nested tool calls are not available in this context",
    },
  ])
  const success: unknown = await tool.execute(
    "selectable-list",
    { action: "list", includeSelection: true },
    undefined,
    undefined,
    ctx,
  )
  if (!record(success) || !Array.isArray(success.content))
    return assert.fail("handler must return content")
  const block: unknown = success.content.find(
    (value: unknown) =>
      record(value) &&
      typeof value.text === "string" &&
      value.text.startsWith('{"workerSelections":'),
  )
  if (!record(block) || typeof block.text !== "string")
    return assert.fail("handler lost exact data")
  assert.deepEqual(JSON.parse(block.text), {
    workerSelections: [
      {
        kind: "runtime-session",
        agentId: identity.id,
        workerSessionId: session,
        cwd: "/project",
      },
    ],
  })
  for (let index = 0; index < 20; index += 1) {
    await Effect.runPromise(
      producer.heartbeatAgent({
        agent: { id: `oversized-${index}:pid:123`, pid: 123 },
        cwd: "/a" + "\n".repeat(1000) + "z",
        label: "worker",
        usage,
        now,
        ttlMs: 60000,
      }),
    )
  }
  const failure: unknown = await tool.execute(
    "oversized-list",
    { action: "list", includeSelection: true },
    undefined,
    undefined,
    runner.createToolContext("oversized-list", undefined),
  )
  if (!record(failure) || !record(failure.details))
    return assert.fail("handler lost typed failure")
  assert.equal(failure.details.outcome, "error")
  assert.match(String(failure.details.error), /invalid_input:.*lower limit/)
  assert.equal("workerSelections" in failure.details, false)
  assert.deepEqual(failure.content, [
    { type: "text", text: failure.details.error },
  ])
  assert.doesNotMatch(
    JSON.stringify(failure.content),
    /workerSelections|oversized-|00000000-0000/,
  )
})
