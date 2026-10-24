import assert from "node:assert/strict"
import test, { type TestContext } from "node:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { Effect } from "effect"
import {
  getPackageDir,
  type ExtensionAPI,
  type ExtensionContext,
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
  const busModule = await import(
    pathToFileURL(join(packageRoot, "dist", "core", "event-bus.js")).href
  )
  let tool: Parameters<ExtensionAPI["registerTool"]>[0] | undefined
  const ctx = {
    cwd: "/project",
    sessionManager: { getSessionId: () => "manager-session" },
    ui: { setStatus: () => {}, setWidget: () => {} },
  } as unknown as ExtensionContext
  let shutdown: (() => Promise<unknown>) | undefined
  // index.ts reads this documented non-secret path key only when constructing its store.
  // Node runs this file in its own process; restore it before executing the handler.
  const previous = process.env.XDG_STATE_HOME
  process.env.XDG_STATE_HOME = root
  try {
    await loader.loadExtensionFromFactory(
      (pi: ExtensionAPI) => {
        registryExtension({
          ...pi,
          on: (name, handler) => {
            if (name === "session_shutdown")
              shutdown = async () =>
                handler({ type: "session_shutdown", reason: "reload" }, ctx)
            pi.on(name, handler)
          },
          registerTool: definition => {
            if (definition.name === "agent_registry") tool = definition
            pi.registerTool(definition)
          },
        })
      },
      process.cwd(),
      busModule.createEventBus(),
      loader.createExtensionRuntime(),
      "registry-selection-execute.test",
    )
  } finally {
    if (previous === undefined) delete process.env.XDG_STATE_HOME
    else process.env.XDG_STATE_HOME = previous
  }
  const producer = makeSqliteRegistryStore(registryStateRoot(root, root))
  t.after(async () => {
    producer.close()
    await shutdown?.()
    rmSync(root, { recursive: true })
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
  if (tool === undefined)
    return assert.fail("actual registered registry tool missing")
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
    ctx,
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
