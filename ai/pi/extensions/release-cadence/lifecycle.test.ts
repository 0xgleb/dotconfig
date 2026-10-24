import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { stripTypeScriptTypes } from "node:module"
import { basename } from "node:path"
import test, { type TestContext } from "node:test"
import {
  dueReleaseCadenceReminder,
  HOUR_MS,
  hourBoundaryAt,
  initialReleaseCadenceState,
  nextHourBoundaryAt,
  restoreReleaseCadenceState,
  type ReleaseCadenceState,
} from "./core.ts"

const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8")
const constantsStart = source.indexOf("const STATE_ENTRY =")
const schemaStart = source.indexOf("const CadenceParameters =")
const implementationStart = source.indexOf("const decodeState =")
assert.ok(constantsStart >= 0 && schemaStart > constantsStart)
assert.ok(implementationStart > schemaStart)
// Run the actual factory and state decoder; only SDK ports and clock are faked.
const implementation = stripTypeScriptTypes(
  source.slice(constantsStart, schemaStart) + source.slice(implementationStart),
).replace("export default", "return")

interface Guards {
  idle: boolean
  pending: boolean
  reload: boolean
  paused: boolean
  owner: boolean
  project: boolean
}
interface Entry {
  type: "custom"
  customType: string
  data: ReleaseCadenceState
}
interface Context {
  cwd: string
  isIdle: () => boolean
  hasPendingMessages: () => boolean
  sessionManager: {
    getBranch: () => Entry[]
    getSessionId: () => string
  }
  ui: {
    setStatus: (key: string, value: string | undefined) => void
    notify: () => void
  }
}
type Handler = (event: unknown, context: Context) => Promise<void> | void
type Action = "enable" | "disable" | "status"
interface Tool {
  name: string
  execute: (
    id: string,
    input: { action: Action },
    signal: undefined,
    onUpdate: undefined,
    context: Context,
  ) => Promise<unknown>
}
interface Message {
  customType: string
  content: string
  display: boolean
}
type Command = (args: string, context: Context) => Promise<void> | void

type Reporter =
  | ((pending: boolean) => void)
  | { report: (identity: { role: string; mode: string }) => void }

const startedAt = Date.parse("2026-01-01T00:30:00Z")
const harness = (t: TestContext) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: startedAt })
  const guards: Guards = {
    idle: true,
    pending: false,
    reload: false,
    paused: false,
    owner: true,
    project: true,
  }
  let entries: Entry[] = []
  const handlers = new Map<string, Handler>()
  const tools = new Map<string, Tool>()
  const commands = new Map<string, Command>()
  const messages: Message[] = []
  const context: Context = {
    cwd: "/workspace/yielduck",
    isIdle: () => guards.idle,
    hasPendingMessages: () => guards.pending,
    sessionManager: {
      getBranch: () => entries,
      getSessionId: () => "test-operator",
    },
    ui: { setStatus: () => {}, notify: () => {} },
  }
  const pi = {
    on: (name: string, handler: Handler) => {
      assert.ok(!handlers.has(name))
      handlers.set(name, handler)
    },
    events: {
      emit: (name: string, payload: Reporter) => {
        if (name === "reload") {
          assert.equal(typeof payload, "function")
          if (typeof payload === "function") payload(guards.reload)
        } else {
          assert.equal(name, "identity")
          assert.equal(typeof payload, "object")
          if (typeof payload === "object" && guards.owner)
            payload.report({ role: "operator", mode: "operational" })
        }
      },
    },
    appendEntry: (customType: string, data: ReleaseCadenceState) => {
      entries.push({ type: "custom", customType, data: structuredClone(data) })
    },
    sendMessage: (
      message: Message,
      options: { triggerTurn: boolean; deliverAs: string },
    ) => {
      assert.deepEqual(options, { triggerTurn: true, deliverAs: "followUp" })
      assert.equal(message.display, false)
      assert.equal(message.customType, "release-cadence.reminder")
      assert.match(message.content, /does not widen authority/)
      messages.push(message)
    },
    registerTool: (tool: Tool) => tools.set(tool.name, tool),
    registerCommand: (name: string, definition: { handler: Command }) => {
      commands.set(name, definition.handler)
    },
  }
  const install: (api: typeof pi) => void = new Function(
    "dependencies",
    `const { basename, runtimeProjectContext, isContinuationPaused,
      REGISTRY_IDENTITY_REQUEST_EVENT, AUTO_RELOAD_PENDING_REQUEST_EVENT,
      registerRuntimeVersion, dueReleaseCadenceReminder, hourBoundaryAt,
      initialReleaseCadenceState, nextHourBoundaryAt, restoreReleaseCadenceState,
      CadenceParameters } = dependencies;
    ${implementation}`,
  )({
    basename,
    runtimeProjectContext: () => ({
      gitToplevel: guards.project ? "/workspace/yielduck" : "/workspace/other",
    }),
    isContinuationPaused: () => guards.paused,
    REGISTRY_IDENTITY_REQUEST_EVENT: "identity",
    AUTO_RELOAD_PENDING_REQUEST_EVENT: "reload",
    registerRuntimeVersion: () => {},
    dueReleaseCadenceReminder,
    hourBoundaryAt,
    initialReleaseCadenceState,
    nextHourBoundaryAt,
    restoreReleaseCadenceState,
    CadenceParameters: {},
  })
  install(pi)
  const dispatch = async (name: string) => {
    const handler = handlers.get(name)
    assert.ok(handler, name)
    await handler({}, context)
  }
  t.after(() => dispatch("session_shutdown"))
  return {
    guards,
    messages,
    dispatch,
    tick: (milliseconds: number) => t.mock.timers.tick(milliseconds),
    action: async (action: Action) => {
      const tool = tools.get("release_cadence")
      assert.ok(tool)
      return tool.execute("test", { action }, undefined, undefined, context)
    },
    command: async (action: Action) => {
      const handler = commands.get("release-cadence")
      assert.ok(handler)
      await handler(action, context)
    },
    state: () => {
      const latest = entries.at(-1)
      assert.ok(latest)
      return latest.data
    },
    replaceBranch: (state: ReleaseCadenceState) => {
      entries = [
        { type: "custom", customType: "release-cadence.state", data: state },
      ]
    },
  }
}

test("commands recheck revoked operator ownership before changing cadence", async t => {
  const runtime = harness(t)
  await runtime.dispatch("session_start")
  runtime.guards.owner = false
  await runtime.command("disable")
  assert.equal(runtime.state().enabled, true)
  runtime.guards.owner = true
  await runtime.command("disable")
  assert.equal(runtime.state().enabled, false)
  runtime.guards.owner = false
  await runtime.command("enable")
  assert.equal(runtime.state().enabled, false)
})

for (const guard of ["idle", "pending", "reload", "paused"] as const) {
  test(`a due reminder survives ${guard} deferral until safe settlement`, async t => {
    const runtime = harness(t)
    await runtime.dispatch("session_start")
    runtime.guards[guard] = guard !== "idle"
    runtime.tick(HOUR_MS / 2)
    assert.equal(runtime.messages.length, 0)
    runtime.tick(10 * 60_000)
    await runtime.dispatch("agent_settled")
    assert.equal(
      runtime.messages.length,
      0,
      "held guard must still block delivery",
    )
    runtime.guards[guard] = guard === "idle"
    await runtime.dispatch("agent_settled")
    assert.equal(runtime.messages.length, 1)
    await runtime.dispatch("agent_settled")
    assert.equal(runtime.messages.length, 1, "same boundary is consumed once")
    runtime.tick(50 * 60_000)
    assert.equal(runtime.messages.length, 2, "next hour remains scheduled")
  })
}

for (const event of ["session_start", "session_tree"]) {
  test(`${event} keeps intentional no-catch-up restoration and new branch state`, async t => {
    const runtime = harness(t)
    await runtime.dispatch("session_start")
    runtime.guards.pending = true
    runtime.tick(HOUR_MS / 2 + 10 * 60_000)
    runtime.replaceBranch({
      enabled: true,
      lastReminderBoundaryAt: hourBoundaryAt(startedAt),
      latestRelease: { version: "9.9.9", at: startedAt },
    })
    runtime.guards.pending = false
    await runtime.dispatch(event)
    assert.equal(runtime.messages.length, 0)
    runtime.tick(50 * 60_000)
    assert.equal(runtime.messages.length, 1)
    assert.match(runtime.messages[0]?.content ?? "", /9\.9\.9/)
  })
}

for (const guard of ["owner", "project"] as const) {
  test(`${guard} loss stops reminders and reacquisition rebases as a new activation`, async t => {
    const runtime = harness(t)
    await runtime.dispatch("session_start")
    runtime.guards[guard] = false
    await runtime.dispatch("agent_settled")
    runtime.tick(HOUR_MS)
    assert.equal(runtime.messages.length, 0)
    runtime.guards[guard] = true
    await runtime.dispatch("agent_settled")
    assert.equal(runtime.messages.length, 0)
    runtime.tick(HOUR_MS / 2)
    assert.equal(runtime.messages.length, 1)
  })
}

test("explicit disable discards wake scheduling until an explicit enable", async t => {
  const runtime = harness(t)
  await runtime.dispatch("session_start")
  runtime.guards.pending = true
  runtime.tick(HOUR_MS / 2)
  await runtime.action("disable")
  runtime.guards.pending = false
  await runtime.dispatch("agent_settled")
  runtime.tick(HOUR_MS)
  assert.equal(runtime.messages.length, 0)
  await runtime.action("enable")
  await runtime.dispatch("agent_settled")
  assert.equal(runtime.messages.length, 0)
  runtime.tick(HOUR_MS)
  assert.equal(runtime.messages.length, 1)
})

test("shutdown cancels the scheduled callback", async t => {
  const runtime = harness(t)
  await runtime.dispatch("session_start")
  await runtime.dispatch("session_shutdown")
  runtime.tick(2 * HOUR_MS)
  assert.equal(runtime.messages.length, 0)
})
