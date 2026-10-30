import assert from "node:assert/strict"
import childProcess from "node:child_process"
import { EventEmitter } from "node:events"
import { syncBuiltinESMExports } from "node:module"
import { homedir } from "node:os"
import { mock } from "node:test"
import { fileURLToPath } from "node:url"
import { Effect, Either } from "effect"
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent"
import type { registerOwnerAllowance } from "../owner-allowance-extension.ts"
import { emptyTodoState, transitionTodoState } from "../../todo/state.ts"

const root = process.argv[2]

assert.ok(root)
assert.equal(homedir(), root)

const added = Effect.runSync(
  Effect.either(
    transitionTodoState(
      emptyTodoState,
      { action: "add", text: "Complete the bounded fixture task." },
      1_000,
    ),
  ),
)

assert.ok(Either.isRight(added))

const branch: ReturnType<ExtensionContext["sessionManager"]["getBranch"]> = [
  {
    id: "fixture-user",
    parentId: null,
    type: "message",
    timestamp: new Date(0).toISOString(),
    message: {
      role: "user",
      content: "Continue the pending fixture task.",
      timestamp: 0,
    },
  },
  {
    id: "fixture-todo",
    parentId: "fixture-user",
    type: "custom",
    timestamp: new Date(0).toISOString(),
    customType: "todo.state",
    data: added.right.state,
  },
]
const hooks = new Map<
  string,
  Set<(event: unknown, ctx: ExtensionContext) => unknown>
>()
const flags = new Map<string, string | boolean | undefined>()
const owners: ReturnType<typeof registerOwnerAllowance>[] = []
const messages: Parameters<ExtensionAPI["sendMessage"]>[] = []
const unexpected: unknown[] = []
const errors: unknown[] = []
const notices: unknown[] = []
let queued = true
let queueChecks = 0
let hostAborts = 0

const synchronous = mock.method(
  childProcess,
  "spawnSync",
  (...args: unknown[]) => {
    unexpected.push(args)

    return {
      status: 1,
      signal: null,
      stdout: "",
      stderr: "unexpected fixture process",
      pid: 0,
      output: [],
    }
  },
)
const asynchronous = mock.method(
  childProcess,
  "spawn",
  (...args: unknown[]) => {
    unexpected.push(args)

    const child = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      kill: () => true,
    })

    queueMicrotask(() =>
      child.emit("error", new Error("unexpected fixture process")),
    )

    return child
  },
)
const errorLog = mock.method(console, "error", (...args: unknown[]) => {
  errors.push(args)
})

syncBuiltinESMExports()

const pi = {
  on: (name, callback) => {
    const callbacks = hooks.get(name) ?? new Set()
    callbacks.add(
      callback as unknown as (event: unknown, ctx: ExtensionContext) => unknown,
    )
    hooks.set(name, callbacks)

    return () => {
      callbacks.delete(
        callback as unknown as (
          event: unknown,
          ctx: ExtensionContext,
        ) => unknown,
      )
    }
  },
  events: { on: () => () => {}, emit: () => {} },
  registerFlag: (name, definition) => {
    flags.set(name, definition.default)
  },
  getFlag: name => flags.get(name),
  registerTool: () => {},
  registerCommand: () => {},
  registerMessageRenderer: () => {},
  registerEntryRenderer: () => {},
  getActiveTools: () => [],
  getSessionName: () => "Continuation fixture",
  appendEntry: (customType, data) => {
    branch.push({
      type: "custom",
      id: `fixture-${branch.length}`,
      parentId: branch.at(-1)?.id ?? null,
      timestamp: new Date().toISOString(),
      customType,
      data,
    })
  },
  sendMessage: (...args) => {
    messages.push(args)
  },
} satisfies Pick<
  ExtensionAPI,
  | "on"
  | "events"
  | "registerFlag"
  | "getFlag"
  | "registerTool"
  | "registerCommand"
  | "registerMessageRenderer"
  | "registerEntryRenderer"
  | "getActiveTools"
  | "getSessionName"
  | "appendEntry"
  | "sendMessage"
>
const ui = {
  setStatus: () => {},
  setWidget: () => {},
  notify: (...args) => {
    notices.push(args)
  },
  getEditorText: () => "",
} satisfies Pick<
  ExtensionContext["ui"],
  "setStatus" | "setWidget" | "notify" | "getEditorText"
>
const session = {
  getBranch: () => branch,
  getEntries: () => branch,
  getSessionId: () => "fixture-session",
} satisfies Pick<
  ExtensionContext["sessionManager"],
  "getBranch" | "getEntries" | "getSessionId"
>
const partialUi: Partial<ExtensionContext["ui"]> = ui
const partialSession: Partial<ExtensionContext["sessionManager"]> = session
const partialContext = {
  cwd: root,
  mode: "print",
  hasUI: false,
  ui: partialUi as ExtensionContext["ui"],
  sessionManager: partialSession as ExtensionContext["sessionManager"],
  isIdle: () => true,
  hasPendingMessages: () => {
    queueChecks += 1

    return queued
  },
  abort: () => {
    hostAborts += 1
  },
} satisfies Partial<ExtensionContext>
const ctx = partialContext as ExtensionContext

const dispatch = async (name: string, event: unknown) => {
  const callbacks = hooks.get(name)
  assert.ok(callbacks?.size, `Actual ${name} registration`)

  for (const callback of callbacks) await callback(event, ctx)
}

try {
  const support: unknown = await import(
    new URL("../../../../test/pi-host-test-support.mjs", import.meta.url).href
  )

  assert.ok(
    typeof support === "object" &&
      support !== null &&
      "loadHostExtension" in support &&
      typeof support.loadHostExtension === "function",
  )

  const factory: unknown = await support.loadHostExtension(
    fileURLToPath(new URL("../index.ts", import.meta.url)),
  )

  assert.ok(typeof factory === "function")

  mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1_000 })

  factory(pi, (guard: ReturnType<typeof registerOwnerAllowance>) => {
    owners.push(guard)
  })

  const owner = owners[0]
  assert.ok(owner)
  assert.equal(owner.admit()._tag, "Left")

  await dispatch("input", {
    type: "input",
    source: "interactive",
    text: "Continue the pending fixture task.",
  })

  assert.equal(owner.admit()._tag, "Right")

  await dispatch("agent_settled", { type: "agent_settled" })
  mock.timers.tick(2_000)

  assert.equal(queueChecks, 1)
  assert.equal(messages.length, 0)
  assert.equal(hostAborts, 0)

  queued = false
  mock.timers.tick(2_000)

  assert.equal(queueChecks, 2)
  assert.equal(messages.length, 1)

  const message = messages[0]
  assert.ok(message)

  assert.equal(message[0].customType, "classified-workflows.task-message")
  assert.ok(typeof message[0].content === "string")
  assert.match(message[0].content, /Complete the bounded fixture task\./)
  assert.deepEqual(message[1], { triggerTurn: true, deliverAs: "followUp" })
  assert.deepEqual(unexpected, [])
} finally {
  if (hooks.has("session_shutdown"))
    await dispatch("session_shutdown", { reason: "reload" })

  mock.timers.reset()
  synchronous.mock.restore()
  asynchronous.mock.restore()
  errorLog.mock.restore()
  syncBuiltinESMExports()
}

assert.deepEqual(unexpected, [])
assert.deepEqual(errors, [])
assert.deepEqual(notices, [])
assert.equal(hostAborts, 1)

process.stdout.write(JSON.stringify({ sent: messages.length, queueChecks }))
