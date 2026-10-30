import assert from "node:assert/strict"
import childProcess from "node:child_process"
import { EventEmitter } from "node:events"
import { syncBuiltinESMExports } from "node:module"
import { homedir } from "node:os"
import { mock } from "node:test"
import { fileURLToPath } from "node:url"
import { Type } from "typebox"
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent"
import type { registerOwnerAllowance } from "../owner-allowance-extension.ts"
import { classifierAttemptBudget } from "../lifecycle.ts"
import { tierCandidates } from "../../shared/model-tiers.ts"
import { ACTIVITY_PHASE_EVENT } from "../../shared/activity-events.ts"
import { REGISTRY_INTENT_REQUEST_EVENT } from "../../shared/registry-intent-events.ts"

const root = process.argv[2]
const scenario = process.argv[3]

assert.equal(typeof root, "string")
assert.ok(root)
assert.equal(homedir(), root)
assert.ok(
  ["aborted", "process-error", "exhausted", "cancelled", "blocked"].includes(
    scenario ?? "",
  ),
)

const candidates = tierCandidates("mid", { now: () => Date.now() })
assert.ok(candidates.length > 0)
const expectedCalls =
  scenario === "exhausted"
    ? classifierAttemptBudget(candidates.length)
    : scenario === "blocked" || scenario === "cancelled"
      ? 1
      : 2
const control = new AbortController()
const probes: unknown[] = []
const processes: { command: unknown; args: unknown; options: unknown }[] = []
const unexpected: unknown[] = []
const failures: string[] = []
let hostAborts = 0

const synchronous = mock.method(
  childProcess,
  "spawnSync",
  (command: unknown, args: unknown, options: unknown) => {
    probes.push({ command, args, options })

    if (
      command !== "git" ||
      JSON.stringify(args) !==
        JSON.stringify(["-C", root, "rev-parse", "--show-toplevel"])
    )
      unexpected.push({ command, args })

    return {
      status: 128,
      signal: null,
      stdout: "",
      stderr: "fixture is outside a repository",
      pid: 0,
      output: [],
    }
  },
)
const asynchronous = mock.method(
  childProcess,
  "spawn",
  (command: unknown, args: unknown, options: unknown) => {
    processes.push({ command, args, options })
    const ordinal = processes.length

    const child = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      kill: () => {
        queueMicrotask(() => child.emit("close", 1))

        return true
      },
    })

    queueMicrotask(() => {
      if (scenario === "cancelled")
        control.abort(new Error("Cancelled by user"))

      if (scenario === "process-error" && ordinal === 1) {
        child.emit(
          "error",
          new DOMException("This operation was aborted", "AbortError"),
        )

        return
      }

      const failed =
        scenario === "exhausted" ||
        ((scenario === "aborted" || scenario === "cancelled") && ordinal === 1)
      const message = {
        role: "assistant",
        content: failed
          ? []
          : [
              {
                type: "text",
                text: JSON.stringify({
                  verdict: scenario === "blocked" ? "block" : "allow",
                  reason: "classified fixture operation",
                }),
              },
            ],
        stopReason: failed ? "aborted" : "stop",
        ...(failed ? { errorMessage: "This operation was aborted" } : {}),
      }

      child.stdout.emit(
        "data",
        JSON.stringify({ type: "message_end", message }) + "\n",
      )
      child.emit("close", failed ? 1 : 0)
    })

    return child
  },
)
const errorLog = mock.method(console, "error", (message: string) => {
  failures.push(message)
})

syncBuiltinESMExports()

const hooks = new Map<
  string,
  Set<(event: unknown, ctx: ExtensionContext) => unknown>
>()
const flags = new Map<string, string | boolean | undefined>()
const events: { name: string; value: unknown }[] = []
const entries: unknown[] = []
const messages: unknown[] = []
const owners: ReturnType<typeof registerOwnerAllowance>[] = []
const tools = new Set<string>()
let executions = 0

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
  events: {
    on: () => () => {},
    emit: (name: string, value: unknown) => {
      events.push({ name, value })
    },
  },
  registerFlag: (name, definition) => {
    flags.set(name, definition.default)
  },
  getFlag: name => flags.get(name),
  registerTool: definition => {
    tools.add(definition.name)
  },
  registerCommand: () => {},
  registerMessageRenderer: () => {},
  registerEntryRenderer: () => {},
  getActiveTools: () => [...tools],
  getSessionName: () => "Classifier fixture",
  appendEntry: (customType, data) => {
    entries.push({ customType, data })
  },
  sendMessage: (message, options) => {
    messages.push({ message, options })
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
  notify: () => {},
} satisfies Pick<ExtensionContext["ui"], "setStatus" | "setWidget" | "notify">
const branch = [
  {
    id: "fixture-input",
    parentId: null,
    type: "message",
    timestamp: new Date(0).toISOString(),
    message: {
      role: "user",
      content: "Run the bounded fixture operation.",
      timestamp: 0,
    },
  },
] satisfies ReturnType<ExtensionContext["sessionManager"]["getBranch"]>
const session = {
  getBranch: () => branch,
  getSessionId: () => "fixture-session",
} satisfies Pick<
  ExtensionContext["sessionManager"],
  "getBranch" | "getSessionId"
>
const partialUi: Partial<ExtensionContext["ui"]> = ui
const partialSession: Partial<ExtensionContext["sessionManager"]> = session
const partialContext = {
  cwd: root,
  mode: "print",
  hasUI: false,
  ui: partialUi as ExtensionContext["ui"],
  sessionManager: partialSession as ExtensionContext["sessionManager"],
  signal: control.signal,
  getContextUsage: () => undefined,
  getSystemPrompt: () => "Read-only fixture operation.",
  abort: () => {
    hostAborts += 1
  },
} satisfies Partial<ExtensionContext>
const ctx = partialContext as ExtensionContext

const dispatch = async (name: string, event: unknown) => {
  const callbacks = hooks.get(name)
  assert.ok(callbacks?.size, `Actual ${name} registration`)

  const results: unknown[] = []
  for (const callback of callbacks) results.push(await callback(event, ctx))

  return results
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

  factory(pi, (guard: ReturnType<typeof registerOwnerAllowance>) => {
    owners.push(guard)
  })

  pi.registerTool({
    name: "fixture_action",
    label: "Fixture action",
    description: "An isolated fixture tool.",
    parameters: Type.Object({}),
    execute: async () => {
      executions += 1

      return { content: [{ type: "text", text: "fixture" }], details: {} }
    },
  })

  const owner = owners[0]
  assert.ok(owner)
  assert.equal(owner.ownerInput(Date.now())._tag, "Right")

  const beforeEntries = structuredClone(entries)
  events.length = 0

  const results = await dispatch("tool_call", {
    type: "tool_call",
    toolCallId: "fixture-call",
    toolName: "fixture_action",
    input: {},
  })

  assert.equal(processes.length, expectedCalls)
  assert.equal(hostAborts, 0)
  assert.equal(executions, 0)
  assert.deepEqual(entries, beforeEntries)
  assert.deepEqual(messages, [])
  assert.deepEqual(
    events.map(event => event.name),
    [REGISTRY_INTENT_REQUEST_EVENT, ACTIVITY_PHASE_EVENT, ACTIVITY_PHASE_EVENT],
  )
  assert.deepEqual(
    events
      .filter(event => event.name === ACTIVITY_PHASE_EVENT)
      .map(event => event.value),
    [
      { active: true, boundary: "action", subject: "fixture_action" },
      { active: false, boundary: "action", subject: "fixture_action" },
    ],
  )
  assert.deepEqual(unexpected, [])
  assert.equal(probes.length, 2)
  assert.deepEqual(failures, [])

  for (const [index, process] of processes.entries()) {
    assert.ok(Array.isArray(process.args))
    const args = process.args
    assert.equal(
      args[args.indexOf("--model") + 1],
      candidates[Math.min(index, candidates.length - 1)],
    )
    for (const flag of [
      "--no-session",
      "--no-tools",
      "--no-extensions",
      "--no-skills",
      "--no-context-files",
    ])
      assert.ok(args.includes(flag))
  }

  const blocked = results.filter(
    (value): value is { block: true; reason: string } =>
      typeof value === "object" &&
      value !== null &&
      "block" in value &&
      value.block === true &&
      "reason" in value &&
      typeof value.reason === "string",
  )

  if (scenario === "blocked")
    assert.deepEqual(blocked, [
      {
        block: true,
        reason: "Auto-classifier verdict: classified fixture operation",
      },
    ])
  else if (scenario === "exhausted" || scenario === "cancelled") {
    assert.equal(blocked.length, 1)
    assert.match(
      blocked[0]?.reason ?? "",
      new RegExp(`after ${expectedCalls} attempts; last failure:`),
    )
    assert.match(
      blocked[0]?.reason ?? "",
      scenario === "cancelled"
        ? /Cancelled by user/
        : /This operation was aborted/,
    )
  } else assert.deepEqual(blocked, [])
} finally {
  if (hooks.has("session_shutdown"))
    await dispatch("session_shutdown", { reason: "reload" })

  synchronous.mock.restore()
  asynchronous.mock.restore()
  errorLog.mock.restore()
  syncBuiltinESMExports()
}

assert.deepEqual(unexpected, [])
assert.deepEqual(failures, [])
assert.equal(hostAborts, 1)
assert.equal(processes.length, expectedCalls)
assert.equal(probes.length, 2)

process.stdout.write(JSON.stringify({ calls: processes.length }))
