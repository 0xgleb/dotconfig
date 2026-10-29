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
import { makeSqliteRegistryStore } from "./sqlite-store.ts"
import { registryStateRoot } from "./paths.ts"
import { runtimeAgentId } from "./runtime-identity.ts"
import {
  REGISTRY_OUTCOME_EVENT,
  type RegistryOutcomeResult,
} from "../shared/registry-intent-events.ts"

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

const fixture = async (t: test.TestContext, owned: boolean) => {
  const root = mkdtempSync(join(tmpdir(), "pi-registry-outcome-"))
  const previousStateHome = process.env.XDG_STATE_HOME
  process.env.XDG_STATE_HOME = root
  const project = join(root, "project")
  const sessionId = "outcome-fixture"
  const agentId = runtimeAgentId(sessionId, process.pid)
  const store = makeSqliteRegistryStore(registryStateRoot(root, "/unused-home"))
  const hooks = new Map<string, Set<Hook>>()
  const listeners = new Map<string, Set<(value: unknown) => void>>()
  const messages: unknown[] = []
  const notices: string[] = []
  const syncErrors: string[] = []
  const ui = {
    setStatus: (key, value) => {
      if (key === "agent-registry-error" && value !== undefined)
        syncErrors.push(value)
    },
    setWidget: () => {},
    notify: message => {
      notices.push(message)
    },
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
  const context = {
    cwd: project,
    mode: "print",
    hasUI: false,
    isIdle: () => false,
    hasPendingMessages: () => true,
    isProjectTrusted: () => false,
    getSystemPrompt: () => "Outcome fixture policy",
    sessionManager: partialSession as ExtensionContext["sessionManager"],
    ui: partialUi as ExtensionUIContext,
  } satisfies Partial<ExtensionContext>
  const ctx = context as ExtensionContext
  const emitHook = async (name: string, value: unknown = {}) => {
    for (const hook of hooks.get(name) ?? []) await hook(value, ctx)
  }

  t.after(async () => {
    try {
      await emitHook("session_shutdown", { reason: "reload" })
      store.close()
      await setImmediate()
    } finally {
      if (previousStateHome === undefined) delete process.env.XDG_STATE_HOME
      else process.env.XDG_STATE_HOME = previousStateHome
      rmSync(root, { recursive: true })
    }
  })

  let leaseId: string | undefined
  let tool:
    Pick<Parameters<ExtensionAPI["registerTool"]>[0], "execute"> | undefined
  const request = await Effect.runPromise(
    store.enqueue({
      project,
      role: "driver-worker",
      requesterId: "fixture-requester",
      text: "Retain complete implementation requirement",
      now: Date.now(),
    }),
  )

  const on: ExtensionAPI["on"] = (name, handler) => {
    const callbacks = hooks.get(name) ?? new Set()
    // Only the actual lifecycle hooks below are driven by the fixture.
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
        for (const callback of listeners.get(name) ?? []) callback(value)
      },
    },
    on,
    registerMessageRenderer: () => {},
    registerCommand: () => {},
    registerTool: definition => {
      tool = definition
    },
    getSessionName: () => "Outcome fixture",
    getActiveTools: () => [],
    appendEntry: () => {},
    sendMessage: (message, options) => {
      messages.push({ message, options })
    },
  } satisfies Pick<
    ExtensionAPI,
    | "events"
    | "on"
    | "registerMessageRenderer"
    | "registerCommand"
    | "registerTool"
    | "getSessionName"
    | "getActiveTools"
    | "appendEntry"
    | "sendMessage"
  >
  const partialHost: Partial<ExtensionAPI> = pi
  factory(partialHost as ExtensionAPI)

  assert.equal(
    listeners.get(REGISTRY_OUTCOME_EVENT)?.size,
    1,
    "actual registration installs the outcome boundary",
  )
  await emitHook("session_start")

  if (owned) {
    assert.ok(tool)
    const facilities = {
      tools: [],
      executeTool: async () => assert.fail("Unexpected nested tool"),
    }
    const toolContext = { ...ctx, ...facilities } satisfies Parameters<
      typeof tool.execute
    >[4]
    const claimed = await tool.execute(
      "claim-outcome-role",
      {
        action: "claim",
        project,
        role: "driver-worker",
        mode: "task",
      },
      undefined,
      undefined,
      toolContext,
    )

    assert.ok(record(claimed.details) && record(claimed.details.lease))
    assert.equal(claimed.details.outcome, "claimed")
    assert.equal(claimed.details.lease.status, "active")
    assert.ok(record(claimed.details.lease.owner))
    assert.equal(claimed.details.lease.owner.id, agentId)
    assert.ok(typeof claimed.details.lease.id === "string")
    leaseId = claimed.details.lease.id
  }

  return {
    store,
    request,
    leaseId,
    diagnostics: () => ({
      messages: [...messages],
      notices: [...notices],
      syncErrors: [...syncErrors],
    }),
    recordOutcome: () =>
      new Promise<RegistryOutcomeResult>(resolve => {
        pi.events.emit(REGISTRY_OUTCOME_EVENT, {
          requestId: request.id,
          resolution: "completed",
          summary: "Completed assigned implementation",
          report: resolve,
        })
      }),
  }
}

test(
  "outcome recording requires an active explicitly owned role",
  { timeout: 3000 },
  async t => {
    const f = await fixture(t, false)
    const before = await Effect.runPromise(f.store.snapshot(Date.now()))

    const result = await f.recordOutcome()

    assert.deepEqual(result, {
      outcome: "failed",
      reason: "request role must be claimed explicitly",
    })
    assert.deepEqual(
      await Effect.runPromise(f.store.snapshot(Date.now())),
      before,
    )
    assert.deepEqual(f.diagnostics(), {
      messages: [],
      notices: [],
      syncErrors: [],
    })
  },
)

test(
  "an owned request outcome records against its existing lease",
  { timeout: 3000 },
  async t => {
    const f = await fixture(t, true)
    const before = await Effect.runPromise(f.store.snapshot(Date.now()))

    const result = await f.recordOutcome()

    assert.deepEqual(result, { outcome: "recorded" })
    const after = await Effect.runPromise(f.store.snapshot(Date.now()))
    assert.equal(before.leases.length, 1)
    assert.equal(after.leases.length, 1)
    const priorLease = before.leases[0]
    const currentLease = after.leases[0]
    assert.ok(priorLease && currentLease)
    const {
      heartbeatAt: priorHeartbeat,
      expiresAt: priorExpiry,
      ...priorIdentity
    } = priorLease
    const {
      heartbeatAt: currentHeartbeat,
      expiresAt: currentExpiry,
      ...currentIdentity
    } = currentLease
    assert.deepEqual(currentIdentity, priorIdentity)
    assert.ok(currentHeartbeat >= priorHeartbeat)
    assert.ok(currentExpiry >= priorExpiry)
    assert.equal(after.requests.length, 1)
    const completed = after.requests[0]
    assert.ok(completed?.status === "completed")
    assert.equal(completed.id, f.request.id)
    assert.equal(completed.leaseId, f.leaseId)
    assert.equal(completed.summary, "Completed assigned implementation")
    assert.equal(completed.text, f.request.text)
    assert.equal(completed.role, "driver-worker")
    assert.deepEqual(f.diagnostics(), {
      messages: [],
      notices: [],
      syncErrors: [],
    })
  },
)
