import assert from "node:assert/strict"
import test from "node:test"
import {
  createEventBus,
  SessionManager,
  DEFAULT_COMPACTION_SETTINGS,
  type ExtensionAPI,
  type ExtensionContext,
  type SessionBeforeCompactEvent,
} from "@earendil-works/pi-coding-agent"
import safeCompaction from "./index.ts"
import { registerAutomaticCompressionOwner } from "../shared/compression-ownership.ts"

type Handler = (event: unknown, context: ExtensionContext) => unknown

const fixture = async () => {
  const session = SessionManager.inMemory("/fixture/compression")
  session.appendMessage({
    role: "user",
    content: "Preserve the current task and its constraints.",
    timestamp: 1,
  })
  const events = createEventBus()
  const handlers = new Map<string, Handler[]>()
  const tools = new Map<string, { execute: (...args: unknown[]) => unknown }>()
  const messages: unknown[] = []
  const warnings: string[] = []
  const writes: unknown[] = []
  const compactions: unknown[] = []
  const context = {
    sessionManager: session,
    ui: { setStatus: () => {}, notify: (text: string) => warnings.push(text) },
    compact: (options: unknown) => compactions.push(options),
  } as unknown as ExtensionContext
  const pi = {
    events,
    on: (name: string, handler: Handler) => {
      const current = handlers.get(name) ?? []
      handlers.set(name, [...current, handler])
    },
    registerMessageRenderer: () => {},
    registerTool: (tool: {
      name: string
      execute: (...args: unknown[]) => unknown
    }) => tools.set(tool.name, tool),
    appendEntry: (kind: string, data: unknown) => {
      writes.push(data)
      session.appendCustomEntry(kind, data)
    },
    sendMessage: (message: unknown) => messages.push(message),
  } as unknown as ExtensionAPI
  safeCompaction(pi)
  const emit = async (name: string, event: unknown) => {
    let result: unknown
    for (const handler of handlers.get(name) ?? [])
      result = await handler(event, context)
    return result
  }
  await emit("session_start", { type: "session_start", reason: "startup" })
  writes.length = 0
  const compact = (
    reason: SessionBeforeCompactEvent["reason"],
    signal = new AbortController().signal,
  ) => {
    const branch = session.getBranch()
    const first = branch[0]
    if (!first) throw new Error("Fixture session has no user entry")
    return emit("session_before_compact", {
      type: "session_before_compact",
      reason,
      signal,
      willRetry: reason === "overflow",
      branchEntries: branch,
      preparation: {
        firstKeptEntryId: first.id,
        messagesToSummarize: [],
        turnPrefixMessages: [],
        isSplitTurn: false,
        tokensBefore: 1000,
        fileOps: { read: new Set(), written: new Set(), edited: new Set() },
        settings: DEFAULT_COMPACTION_SETTINGS,
      },
    } satisfies SessionBeforeCompactEvent)
  }
  return {
    pi,
    session,
    compact,
    emit,
    messages,
    warnings,
    writes,
    compactions,
    tools,
    context,
  }
}

test("the registered native threshold path still prepares when no compressor owns the session", async () => {
  const f = await fixture()
  assert.deepEqual(await f.compact("threshold"), { cancel: true })
  assert.equal(f.messages.length, 1)
  assert.equal(f.writes.length, 1)
  assert.equal(f.warnings.length, 0)
})

test("unmanaged overflow retains the model-free native recovery path", async () => {
  const f = await fixture()
  const result = await f.compact("overflow")
  const serialized = JSON.stringify(result)
  assert.match(serialized, /"compaction"/u)
  assert.match(serialized, /"tokensBefore":1000/u)
  assert.match(serialized, /Preserve the current task and its constraints/u)
  assert.equal(f.writes.length, 1)
  assert.equal(f.messages.length, 0)
  assert.equal(f.warnings.length, 0)
})

for (const reason of ["threshold", "overflow"] as const) {
  test(`a managed ${reason} event never starts native preparation or summary`, async () => {
    const f = await fixture()
    registerAutomaticCompressionOwner(f.pi, async context => ({
      owner: "billion-context",
      sessionId: context.sessionManager.getSessionId(),
    }))
    assert.deepEqual(await f.compact(reason), { cancel: true })
    assert.equal(f.messages.length, 0)
    assert.equal(f.writes.length, 0)
    assert.equal(f.compactions.length, 0)
  })
}

test("manual checkpoint preparation and readiness ignore the automatic compressor", async () => {
  const f = await fixture()
  let ownershipCalls = 0
  registerAutomaticCompressionOwner(f.pi, async context => {
    ownershipCalls++
    return {
      owner: "billion-context",
      sessionId: context.sessionManager.getSessionId(),
    }
  })
  assert.deepEqual(await f.compact("manual"), { cancel: true })
  const ready = f.tools.get("safe_compaction_ready")
  if (!ready) throw new Error("Readiness tool was not registered")
  await ready.execute(
    "fixture-ready",
    { resumeNotes: "Continue the exact task without replay." },
    new AbortController().signal,
    undefined,
    f.context,
  )
  await f.emit("agent_settled", { type: "agent_settled" })
  assert.equal(f.compactions.length, 1)
  assert.equal(ownershipCalls, 0)
})

for (const kind of ["unavailable", "foreign", "conflicting"] as const) {
  test(`a ${kind} ownership claim warns and retains native threshold safety`, async () => {
    const f = await fixture()
    const resolve = async () => {
      if (kind === "unavailable")
        return Promise.reject(new Error("Fixture unavailable"))
      return { owner: "billion-context" as const, sessionId: "foreign-session" }
    }
    registerAutomaticCompressionOwner(f.pi, resolve)
    if (kind === "conflicting") registerAutomaticCompressionOwner(f.pi, resolve)
    assert.deepEqual(await f.compact("threshold"), { cancel: true })
    assert.equal(f.messages.length, 1)
    assert.equal(f.writes.length, 1)
    assert.equal(f.warnings.length, 1)
    assert.match(f.warnings[0] ?? "", /native.*(?:safety|protection)/iu)
  })
}

for (const lifecycle of ["session_shutdown", "session_start"] as const) {
  test(`${lifecycle} invalidates an in-flight claim even when the session ID is unchanged`, async () => {
    const f = await fixture()
    const entered = new Promise<void>(accept => {
      registerAutomaticCompressionOwner(
        f.pi,
        () =>
          new Promise(() => {
            accept()
          }),
      )
    })
    const pending = f.compact("threshold")
    assert.equal(
      await Promise.race([
        entered.then(() => "entered"),
        pending.then(() => "completed-before-controller"),
      ]),
      "entered",
    )
    await f.emit(lifecycle, { type: lifecycle, reason: "reload" })
    assert.deepEqual(await pending, { cancel: true })
    assert.equal(f.messages.length, 0)
    assert.equal(f.writes.length, 0)
    assert.equal(f.warnings.length, 0)
  })
}

test("cancelled automatic compaction creates no checkpoint or error notification", async () => {
  const f = await fixture()
  const controller = new AbortController()
  controller.abort()
  assert.deepEqual(await f.compact("threshold", controller.signal), {
    cancel: true,
  })
  assert.equal(f.messages.length, 0)
  assert.equal(f.writes.length, 0)
  assert.equal(f.warnings.length, 0)
})
