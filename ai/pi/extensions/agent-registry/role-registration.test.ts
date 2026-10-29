import assert from "node:assert/strict"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { setImmediate } from "node:timers/promises"
import test from "node:test"
import { fileURLToPath, pathToFileURL } from "node:url"
import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionUIContext,
} from "@earendil-works/pi-coding-agent"
import { registryStateRoot } from "./paths.ts"

type RegisteredTool = Pick<
  Parameters<ExtensionAPI["registerTool"]>[0],
  "name" | "parameters" | "execute"
>
type Shutdown = (event: unknown, ctx: ExtensionContext) => unknown

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null

const support: unknown = await import(
  new URL("../../../test/pi-host-test-support.mjs", import.meta.url).href
)

assert.ok(record(support) && typeof support.loadHostExtension === "function")

const factory: unknown = await support.loadHostExtension(
  fileURLToPath(new URL("./index.ts", import.meta.url)),
)

assert.ok(typeof factory === "function")

const { getPackageDir } = await import("@earendil-works/pi-coding-agent")
const validation: unknown = await import(
  pathToFileURL(
    join(
      getPackageDir(),
      "node_modules/@earendil-works/pi-ai/dist/utils/validation.js",
    ),
  ).href
)

assert.ok(
  record(validation) && typeof validation.validateToolArguments === "function",
)

const validateToolArguments = validation.validateToolArguments

const fixture = (t: test.TestContext) => {
  const root = mkdtempSync(join(tmpdir(), "pi-registry-role-tool-"))
  // This public state-directory input is isolated before actual registration.
  const previousStateHome = process.env.XDG_STATE_HOME
  process.env.XDG_STATE_HOME = root

  let shutdown: Shutdown | undefined
  const listeners = new Map<string, Set<(data: unknown) => void>>()
  const connections = new Set<DatabaseSync>()
  let tool: RegisteredTool | undefined

  const ui = {
    setStatus: () => {},
    setWidget: () => {},
  } satisfies Pick<ExtensionUIContext, "setStatus" | "setWidget">
  const sessionManager = {
    getSessionId: () => "registered-role-fixture",
    getBranch: () => [],
  } satisfies Pick<
    ExtensionContext["sessionManager"],
    "getSessionId" | "getBranch"
  >
  const partialUi: Partial<ExtensionUIContext> = ui
  const partialSession: Partial<ExtensionContext["sessionManager"]> =
    sessionManager
  const context = {
    cwd: "/projects/registered-role-fixture",
    mode: "print",
    hasUI: false,
    getSystemPrompt: () => "Registered role fixture policy",
    sessionManager: partialSession as ExtensionContext["sessionManager"],
    ui: partialUi as ExtensionUIContext,
  } satisfies Partial<ExtensionContext>
  const ctx = context as ExtensionContext

  t.after(async () => {
    try {
      await shutdown?.({ type: "session_shutdown", reason: "reload" }, ctx)
      await setImmediate()
      assert.equal(
        connections.size,
        0,
        "registry handles close before fixture removal",
      )
    } finally {
      if (previousStateHome === undefined) delete process.env.XDG_STATE_HOME
      else process.env.XDG_STATE_HOME = previousStateHome
      rmSync(root, { recursive: true })
    }
  })

  const prepare = DatabaseSync.prototype.prepare
  const close = DatabaseSync.prototype.close

  // Observe real handles without replacing SQL execution or domain outcomes.
  t.mock.method(
    DatabaseSync.prototype,
    "prepare",
    function (this: DatabaseSync, sql: string) {
      connections.add(this)
      return prepare.call(this, sql)
    },
  )
  t.mock.method(DatabaseSync.prototype, "close", function (this: DatabaseSync) {
    close.call(this)
    connections.delete(this)
  })

  const on: ExtensionAPI["on"] = (name, handler) => {
    // Only shutdown is driven; session_start would collect backlog/start timers.
    if (name !== "session_shutdown") return () => {}

    const captured = handler as unknown as Shutdown
    shutdown = captured

    return () => {
      if (shutdown === captured) shutdown = undefined
    }
  }
  const pi = {
    events: {
      on: (name: string, listener: (data: unknown) => void) => {
        const callbacks = listeners.get(name) ?? new Set()
        callbacks.add(listener)
        listeners.set(name, callbacks)

        return () => {
          callbacks.delete(listener)
        }
      },
      emit: (name: string, data: unknown) => {
        for (const listener of listeners.get(name) ?? []) listener(data)
      },
    },
    on,
    registerMessageRenderer: () => {},
    registerCommand: () => {},
    registerTool: definition => {
      tool = definition
    },
  } satisfies Pick<
    ExtensionAPI,
    | "events"
    | "on"
    | "registerMessageRenderer"
    | "registerCommand"
    | "registerTool"
  >
  const partialHost: Partial<ExtensionAPI> = pi

  // Unused SDK facilities are absent; every implemented method is checked above.
  factory(partialHost as ExtensionAPI)

  assert.ok(tool, "real registration exposes the agent_registry tool")
  assert.equal(tool.name, "agent_registry")

  const captured = tool
  const toolFacilities = {
    tools: [],
    executeTool: async () => assert.fail("Unexpected nested tool invocation"),
  }
  const toolContext = {
    ...ctx,
    ...toolFacilities,
  } satisfies Parameters<typeof captured.execute>[4]

  return {
    databasePath: join(
      registryStateRoot(root, "/unused-home"),
      "registry.sqlite",
    ),
    validate: (args: unknown) =>
      validateToolArguments(captured, {
        type: "toolCall",
        id: "registry-role-validation",
        name: captured.name,
        arguments: args,
      }),
    execute: (args: unknown) =>
      captured.execute(
        "registry-role-call",
        args,
        undefined,
        undefined,
        toolContext,
      ),
  }
}

for (const role of [
  "maintainer",
  "developer",
  "pi-support",
  "operator",
  "reviewer",
  "worker",
  " manager ",
  "",
])
  test(`actual SDK rejects unsupported registry role ${JSON.stringify(role)}`, t => {
    const f = fixture(t)

    assert.throws(() => f.validate({ action: "claim", role }))
    assert.equal(existsSync(f.databasePath), false)
  })

for (const action of [
  "list",
  "requests",
  "claim",
  "release",
  "delegate",
  "clear",
  "claim_request",
  "start_request",
  "review_request",
  "publish_request",
  "complete_request",
  "fail_request",
  "cancel_request",
  "ingest_backlog",
])
  test(`raw registered ${action} rejects malformed roles before opening SQLite`, async t => {
    const f = fixture(t)

    for (const role of ["developer", " manager ", "", null, 42, {}]) {
      const result = await f.execute({ action, role, text: "Fixture request" })

      assert.ok(record(result.details))
      assert.equal(result.details.outcome, "error")
      assert.match(
        String(result.details.error),
        /invalid_input: Agent role must be manager, driver-worker, or review-worker\./u,
      )
      assert.equal(existsSync(f.databasePath), false)
    }
  })

for (const action of ["claim", "release", "delegate"])
  test(`registered ${action} still rejects an omitted role`, async t => {
    const f = fixture(t)

    const result = await f.execute({ action })

    assert.ok(record(result.details))
    assert.equal(result.details.outcome, "error")
    assert.equal(result.details.error, "invalid_input: role required")
    assert.equal(existsSync(f.databasePath), false)
  })

test("all three SDK-validated canonical roles persist through real registered claims", async t => {
  const f = fixture(t)

  for (const role of ["manager", "driver-worker", "review-worker"]) {
    const args = f.validate({ action: "claim", role })

    const result = await f.execute(args)

    assert.ok(record(result.details) && record(result.details.lease))
    assert.equal(result.details.outcome, "claimed")
    assert.equal(result.details.lease.role, role)
  }

  const database = new DatabaseSync(f.databasePath, { readOnly: true })

  try {
    assert.deepEqual(
      database
        .prepare("SELECT role FROM leases ORDER BY role")
        .all()
        .map(row => row.role),
      ["driver-worker", "manager", "review-worker"],
    )
  } finally {
    database.close()
  }
})

test("omitting the optional role still permits a real registered listing", async t => {
  const f = fixture(t)
  const args = f.validate({ action: "list" })

  const result = await f.execute(args)

  assert.ok(record(result.details))
  assert.equal(result.details.outcome, "success")
  assert.equal(existsSync(f.databasePath), true)
})

test("SDK optional-null normalization permits listing but never selects a claim role", async t => {
  const f = fixture(t)

  const listed = await f.execute(f.validate({ action: "list", role: null }))
  const claimed = await f.execute(f.validate({ action: "claim", role: null }))

  assert.ok(record(listed.details) && record(claimed.details))
  assert.equal(listed.details.outcome, "success")
  assert.equal(claimed.details.outcome, "error")
  assert.equal(claimed.details.error, "invalid_input: role required")

  const database = new DatabaseSync(f.databasePath, { readOnly: true })

  try {
    assert.equal(
      database.prepare("SELECT COUNT(*) AS count FROM leases").get()?.count,
      0,
    )
  } finally {
    database.close()
  }
})
