import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setImmediate } from "node:timers/promises"
import test from "node:test"
import { fileURLToPath } from "node:url"
import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionUIContext,
} from "@earendil-works/pi-coding-agent"
import { Effect } from "effect"
import { makeRemoteBridgeStore } from "./sqlite-store.ts"
import { remoteBridgeDatabasePath } from "./paths.ts"
import { BRIDGE_AGENT_TTL_MS, BRIDGE_MESSAGE_TTL_MS } from "./protocol.ts"
import {
  REGISTRY_DELEGATE_REQUEST_EVENT,
  REGISTRY_PROJECTS_REQUEST_EVENT,
} from "../shared/registry-intent-events.ts"

import { REMOTE_CAPABILITY_MESSAGE } from "../shared/remote-capability.ts"

type Hook = (event: unknown, ctx: ExtensionContext) => unknown

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

const fixture = async (t: test.TestContext) => {
  const root = mkdtempSync(join(tmpdir(), "pi-routing-role-"))
  const previousStateHome = process.env.XDG_STATE_HOME
  process.env.XDG_STATE_HOME = root
  const sessionId = "routing-role-fixture"
  const ownProject = join(root, "dispatcher")
  const targetProject = join(root, "target")
  const store = makeRemoteBridgeStore(
    remoteBridgeDatabasePath(root, "/unused-home"),
  )
  const hooks = new Map<string, Set<Hook>>()
  const listeners = new Map<string, Set<(value: unknown) => void>>()
  const delegateEvents: unknown[] = []
  const prompts: string[] = []
  const entries: unknown[] = []
  let tools = ["todo", "bash"]
  let began: (() => void) | undefined
  const routingStarted = new Promise<void>(resolve => {
    began = resolve
  })

  const ui = {
    setStatus: () => {},
    setWidget: () => {},
    notify: () => {},
    getEditorText: () => "",
  } satisfies Pick<
    ExtensionUIContext,
    "setStatus" | "setWidget" | "notify" | "getEditorText"
  >
  const sessionManager = {
    getSessionId: () => sessionId,
    getBranch: () => [],
  } satisfies Pick<
    ExtensionContext["sessionManager"],
    "getSessionId" | "getBranch"
  >
  const partialSession: Partial<ExtensionContext["sessionManager"]> =
    sessionManager
  const partialUi: Partial<ExtensionUIContext> = ui
  const modelIdentity: Partial<NonNullable<ExtensionContext["model"]>> = {
    provider: "ollama",
    id: "routing-fixture",
  }
  const context = {
    cwd: ownProject,
    mode: "print",
    hasUI: false,
    model: modelIdentity as NonNullable<ExtensionContext["model"]>,
    isIdle: () => true,
    hasPendingMessages: () => false,
    sessionManager: partialSession as ExtensionContext["sessionManager"],
    ui: partialUi as ExtensionUIContext,
  } satisfies Partial<ExtensionContext>
  const ctx = context as ExtensionContext

  const emit = async (name: string, event: unknown = {}) => {
    for (const hook of hooks.get(name) ?? []) await hook(event, ctx)
  }

  t.after(async () => {
    try {
      await emit("session_shutdown", { reason: "reload" })
      await setImmediate()
    } finally {
      if (previousStateHome === undefined) delete process.env.XDG_STATE_HOME
      else process.env.XDG_STATE_HOME = previousStateHome
      rmSync(root, { recursive: true })
    }
  })

  const on: ExtensionAPI["on"] = (name, handler) => {
    const callbacks = hooks.get(name) ?? new Set()
    // The fixture drives only the captured lifecycle-event projections below.
    const callback = handler as unknown as Hook
    callbacks.add(callback)
    hooks.set(name, callbacks)
    return () => {
      callbacks.delete(callback)
    }
  }
  const pi = {
    events: {
      on: (name: string, callback: (value: unknown) => void) => {
        const callbacks = listeners.get(name) ?? new Set()
        callbacks.add(callback)
        listeners.set(name, callbacks)
        return () => {
          callbacks.delete(callback)
        }
      },
      emit: (name: string, value: unknown) => {
        if (name === REGISTRY_PROJECTS_REQUEST_EVENT) {
          assert.ok(record(value) && typeof value.report === "function")
          value.report([ownProject, targetProject])
        }
        if (name === REGISTRY_DELEGATE_REQUEST_EVENT) {
          delegateEvents.push(value)
          assert.ok(record(value) && typeof value.report === "function")
          // Finish an incorrect request so failure is observed without a timeout.
          value.report({
            outcome: "failed",
            reason: "unsupported implicit role",
          })
        }
        for (const callback of listeners.get(name) ?? []) callback(value)
      },
    },
    on,
    registerTool: () => {},
    registerCommand: () => {},
    appendEntry: (_type, value) => {
      entries.push(value)
    },
    getSessionName: () => "Routing fixture",
    getActiveTools: () => [...tools],
    setActiveTools: values => {
      tools = [...values]
    },
    sendMessage: (message, options) => {
      assert.equal(message.customType, REMOTE_CAPABILITY_MESSAGE)
      assert.equal(message.display, false)
      assert.equal(options?.triggerTurn, undefined)
    },
    sendUserMessage: content => {
      prompts.push(
        typeof content === "string"
          ? content
          : content
              .flatMap(part => (part.type === "text" ? [part.text] : []))
              .join("\n"),
      )
      began?.()
    },
  } satisfies Pick<
    ExtensionAPI,
    | "events"
    | "on"
    | "registerTool"
    | "registerCommand"
    | "appendEntry"
    | "getSessionName"
    | "getActiveTools"
    | "setActiveTools"
    | "sendMessage"
    | "sendUserMessage"
  >
  const partialHost: Partial<ExtensionAPI> = pi
  factory(partialHost as ExtensionAPI)

  for (const [id, cwd] of [
    [sessionId, ownProject],
    ["target-fixture", targetProject],
  ] as const) {
    await Effect.runPromise(
      store.heartbeatAgent({
        id,
        label: id,
        cwd,
        accepting: true,
        workDelivery: "native-pi",
        now: Date.now(),
        ttlMs: BRIDGE_AGENT_TTL_MS,
      }),
    )
  }
  const originals = [
    "Inspect the first module.\nPreserve its constraint.",
    "Inspect the second module without unrelated edits.",
  ]
  const messages = []
  for (const [index, text] of originals.entries()) {
    messages.push(
      await Effect.runPromise(
        store.enqueue({
          targetAgentId: sessionId,
          requesterId: "telegram-owner-fixture",
          dedupeKey: `fixture-${index}`,
          text,
          now: Date.now(),
          ttlMs: BRIDGE_MESSAGE_TTL_MS,
        }),
      ),
    )
  }

  return {
    originals,
    messages,
    store,
    ownProject,
    targetProject,
    delegateEvents,
    tools: () => [...tools],
    prompts: () => [...prompts],
    start: async () => {
      await emit("session_start")
      await routingStarted
    },
    finish: (response: string) =>
      emit("agent_end", {
        messages: [
          {
            role: "assistant",
            content: [{ type: "text", text: response }],
            stopReason: "stop",
          },
        ],
      }),
  }
}

for (const mode of ["project-directive", "owned-project-fallback"] as const)
  test(`actual routing ${mode} requires a recipient role and conserves every message`, async t => {
    const f = await fixture(t)

    await f.start()

    assert.deepEqual(f.tools(), [])
    const prompts = f.prompts()
    assert.equal(prompts.length, 1)
    for (const original of f.originals)
      assert.ok(
        prompts[0]?.includes(original),
        "routing prompt preserves complete source text",
      )

    for (const message of f.messages) {
      const claimed = await Effect.runPromise(
        f.store.get(message.id, Date.now()),
      )
      assert.equal(claimed.status, "claimed")
    }
    const response =
      mode === "project-directive"
        ? `route: ${f.targetProject} | messages: 1, 2 | note: Keep the full source text`
        : "No explicit routing directive."

    await f.finish(response)

    assert.equal(
      f.delegateEvents.length,
      0,
      "project selection cannot invent a registry role",
    )
    assert.deepEqual(f.tools(), ["todo", "bash"])
    for (const [index, message] of f.messages.entries()) {
      const completed = await Effect.runPromise(
        f.store.get(message.id, Date.now()),
      )
      assert.equal(completed.status, "completed")
      assert.equal(completed.text, f.originals[index])
      assert.ok(completed.status === "completed")
      const destination =
        mode === "project-directive" ? f.targetProject : f.ownProject
      assert.ok(
        completed.response.startsWith(
          `Routed to ${destination} FAILED: missing_selection`,
        ),
        completed.response,
      )
      assert.doesNotMatch(completed.response, /request [0-9a-f-]+|model_error/u)
    }
  })
