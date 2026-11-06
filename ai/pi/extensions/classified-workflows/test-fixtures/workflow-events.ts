import assert from "node:assert/strict"
import { homedir } from "node:os"
import { mock } from "node:test"
import { fileURLToPath } from "node:url"
import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionUIContext,
} from "@earendil-works/pi-coding-agent"
import {
  QUESTION_STATE_EVENT,
  QUESTION_RESOLVED_EVENT,
} from "../../shared/question-events.ts"
import { CONTINUATION_PAUSE_ENTRY } from "../../shared/continuation-pause.ts"
import { CAPABILITY_CIRCUIT_ENTRY } from "../capability-circuit.ts"
import { REMOTE_CAPABILITY_HANDSHAKE_EVENT } from "../../shared/remote-capability.ts"

const root = process.argv[2]
const scenario = process.argv[3]
assert.ok(
  typeof root === "string" &&
    [
      "snapshots",
      "resolutions",
      "handshakes",
      "notice",
      "stale",
      "valid",
    ].includes(scenario ?? ""),
)
assert.equal(homedir(), root)

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

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null
const snapshot = {
  questions: [{ id: 1, question: "Continue?", status: "pending" }],
}
const invalidSnapshots: unknown[] = [
  undefined,
  null,
  {},
  { questions: null },
  { questions: [{ id: 1, status: "resolved", question: "Q" }] },
  {
    questions: [{ id: 1, status: "pending", question: "Q", header: undefined }],
  },
  {
    questions: [
      { id: 1, status: "pending", question: "Q", options: undefined },
    ],
  },
  {
    questions: [
      {
        id: 1,
        status: "pending",
        question: "Q",
        options: [{ label: "Yes", description: undefined }],
      },
    ],
  },
]
const invalidResolutions: unknown[] = [
  undefined,
  null,
  { id: 1, answer: 7 },
  { id: 0, answer: "yes" },
]
const invalidHandshakes: unknown[] = [
  undefined,
  null,
  { status: "invented" },
  {
    status: "restored",
    recoveryAttempts: 0,
    expectedTools: [],
    activeTools: [7],
  },
]
const payloads =
  scenario === "snapshots"
    ? invalidSnapshots
    : scenario === "resolutions"
      ? invalidResolutions
      : scenario === "handshakes"
        ? invalidHandshakes
        : [null]
const results: unknown[] = []
const logs: string[] = []
const logMock = mock.method(console, "error", (message: string) => {
  logs.push(message)
})

type Hook = (event: unknown, ctx: ExtensionContext) => unknown
for (const payload of payloads) {
  const hooks = new Map<string, Set<Hook>>()
  const listeners = new Map<string, Set<(value: unknown) => void>>()
  const commands = new Map<
    string,
    Pick<Parameters<ExtensionAPI["registerCommand"]>[1], "handler">
  >()
  const entries: { customType: string; data: unknown }[] = []
  const messages: unknown[] = []
  const attempted: unknown[] = []
  const emitted: string[] = []
  const statuses = new Map<string, string | undefined>()
  let failSender = false
  const ui = {
    setStatus: (key, value) => {
      statuses.set(key, value)
    },
    setWidget: () => {},
    notify: () => {},
  } satisfies Pick<ExtensionUIContext, "setStatus" | "setWidget" | "notify">
  const sessionManager = { getBranch: () => [] } satisfies Pick<
    ExtensionContext["sessionManager"],
    "getBranch"
  >
  const partialUi: Partial<ExtensionUIContext> = ui
  const partialSession: Partial<ExtensionContext["sessionManager"]> =
    sessionManager
  const context = {
    cwd: root,
    mode: "print",
    hasUI: false,
    ui: partialUi as ExtensionUIContext,
    sessionManager: partialSession as ExtensionContext["sessionManager"],
  } satisfies Partial<ExtensionContext>
  const ctx = context as ExtensionContext
  const on: ExtensionAPI["on"] = (name, handler) => {
    const callbacks = hooks.get(name) ?? new Set()
    callbacks.add(handler as unknown as Hook)
    hooks.set(name, callbacks)

    return () => {
      callbacks.delete(handler as unknown as Hook)
    }
  }
  const pi = {
    on,
    events: {
      on: (name: string, callback: (value: unknown) => void) => {
        const callbacks = listeners.get(name) ?? new Set()
        callbacks.add(callback)
        listeners.set(name, callbacks)

        return () => {
          callbacks.delete(callback)
        }
      },
      emit: (name: string) => {
        emitted.push(name)
      },
    },
    registerTool: () => {},
    registerMessageRenderer: () => {},
    registerEntryRenderer: () => {},
    registerFlag: () => {},
    registerCommand: (name, command) => {
      commands.set(name, command)
    },
    getFlag: () => undefined,
    getSessionName: () => "Event fixture",
    getActiveTools: () => [],
    appendEntry: (customType, data) => {
      entries.push({ customType, data })
    },
    sendMessage: (message, options) => {
      attempted.push({ message, options })

      if (failSender) throw new Error("sensitive sender sentinel")

      messages.push({ message, options })
    },
  } satisfies Pick<
    ExtensionAPI,
    | "on"
    | "events"
    | "registerTool"
    | "registerMessageRenderer"
    | "registerEntryRenderer"
    | "registerFlag"
    | "registerCommand"
    | "getFlag"
    | "getSessionName"
    | "getActiveTools"
    | "appendEntry"
    | "sendMessage"
  >
  const partialHost: Partial<ExtensionAPI> = pi
  const emit = (name: string, value: unknown) => {
    const callbacks = listeners.get(name)
    assert.equal(callbacks?.size, 1, `Actual ${name} registration`)
    assert.ok(callbacks)

    for (const callback of callbacks) callback(value)
  }
  const dispatch = async (name: string, event: unknown) => {
    const callbacks = hooks.get(name)
    assert.ok(callbacks?.size, `Actual ${name} hook`)

    for (const callback of callbacks) await callback(event, ctx)
  }

  try {
    factory(partialHost as ExtensionAPI)

    const command = commands.get("workflows")
    assert.ok(command)

    await command.handler(
      "status",
      ctx as Parameters<typeof command.handler>[1],
    )
    await dispatch("agent_end", {
      messages: [{ role: "assistant", stopReason: "aborted", content: [] }],
    })
    emit(QUESTION_STATE_EVENT, snapshot)
    emit(REMOTE_CAPABILITY_HANDSHAKE_EVENT, {
      status: "failed",
      recoveryAttempts: 1,
      expectedTools: ["read"],
      activeTools: [],
    })

    assert.equal(
      statuses.get("continuation-pause"),
      "continuation:paused · waiting for you",
    )
    assert.equal(
      statuses.get("capability-circuit"),
      "continuation:paused · local tools unavailable",
    )

    entries.length = 0
    messages.length = 0
    attempted.length = 0
    emitted.length = 0
    failSender = scenario === "stale"

    const eventName =
      scenario === "resolutions"
        ? QUESTION_RESOLVED_EVENT
        : scenario === "handshakes"
          ? REMOTE_CAPABILITY_HANDSHAKE_EVENT
          : QUESTION_STATE_EVENT

    if (scenario !== "valid") {
      emit(eventName, payload)

      assert.deepEqual(entries, [])
      assert.equal(
        statuses.get("continuation-pause"),
        "continuation:paused · waiting for you",
      )
      assert.equal(
        statuses.get("capability-circuit"),
        "continuation:paused · local tools unavailable",
      )
      assert.deepEqual(attempted, [
        {
          message: {
            customType: "workflow.invalid-event",
            content: `Invalid workflow event payload: ${eventName}`,
            display: true,
          },
          options: { triggerTurn: false },
        },
      ])
      assert.deepEqual(messages, failSender ? [] : attempted)
    }

    failSender = false
    emit(QUESTION_RESOLVED_EVENT, { id: 1, answer: "yes" })
    emit(REMOTE_CAPABILITY_HANDSHAKE_EVENT, {
      status: "restored",
      recoveryAttempts: 0,
      expectedTools: ["read"],
      activeTools: ["read"],
    })

    const pause = entries.find(
      entry => entry.customType === CONTINUATION_PAUSE_ENTRY,
    )
    const circuit = entries.find(
      entry => entry.customType === CAPABILITY_CIRCUIT_ENTRY,
    )
    assert.ok(pause && record(pause.data) && pause.data.paused === false)
    assert.ok(
      circuit &&
        record(circuit.data) &&
        circuit.data.open === false &&
        circuit.data.consecutiveBlockers === 0,
    )
    assert.equal(statuses.get("continuation-pause"), undefined)
    assert.equal(statuses.get("capability-circuit"), undefined)
    assert.deepEqual(emitted, [])
    assert.equal(attempted.length, scenario === "valid" ? 0 : 1)
    assert.equal(
      messages.length,
      scenario === "valid" || scenario === "stale" ? 0 : 1,
    )

    results.push({
      rejected: scenario !== "valid",
      attempts: attempted,
      messages,
    })
  } finally {
    await dispatch("session_shutdown", { reason: "reload" })
  }
}

logMock.mock.restore()

assert.equal(logs.length, scenario === "stale" ? 1 : 0)
if (scenario === "stale") {
  assert.deepEqual(JSON.parse(logs[0] ?? ""), {
    level: "error",
    component: "classified-workflows",
    event: "notice-delivery-failed",
    operation: "decode internal event",
  })
  assert.doesNotMatch(logs.join("\n"), /sensitive/u)
}

process.stdout.write(JSON.stringify({ cases: results.length }))
