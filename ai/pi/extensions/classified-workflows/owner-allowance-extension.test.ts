import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { OWNER_ALLOWANCE_ENTRY, OWNER_ALLOWANCE_MS } from "./owner-allowance.ts"

test("production entrypoint installs the hard deadline guard and cancels detached workers", () => {
  const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8")
  assert.ok(
    /registerOwnerAllowance\(\s*pi\s*,/u.test(source),
    "production must install the guard",
  )
  assert.ok(
    /ownerAllowance\.admit\(\)/.test(source),
    "continuations must check the deadline",
  )
  assert.ok(
    /registerRuntimeVersion\(pi, "owner-allowance", "2026\.10\.25\.1"\)/.test(
      source,
    ),
    "the two-hour allowance runtime marker must be registered",
  )
})

for (const elapsedMinutes of [90, 150]) {
  test(`registered session-start restores a historical four-hour window at ${elapsedMinutes} minutes`, async t => {
    t.mock.timers.enable({
      apis: ["Date", "setTimeout"],
      now: 1000 + elapsedMinutes * 60_000,
    })
    const callbacks = new Map<string, (...args: unknown[]) => unknown>()
    const saved: unknown[] = []
    let aborts = 0
    const host = {
      on: (name: string, callback: (...args: unknown[]) => unknown) =>
        callbacks.set(name, callback),
      appendEntry: (type: string, data: unknown) => {
        assert.equal(type, OWNER_ALLOWANCE_ENTRY)
        saved.push(data)
      },
      registerCommand: () => {},
    }
    const ctx = {
      abort: () => {
        aborts++
      },
      ui: { setStatus: () => {}, notify: () => {} },
      sessionManager: {
        getEntries: () => [
          {
            type: "custom",
            customType: OWNER_ALLOWANCE_ENTRY,
            data: {
              version: 1,
              lastOwnerAt: 1000,
              deadlineAt: 1000 + 4 * 60 * 60 * 1000,
              status: "active",
            },
          },
        ],
      },
    }
    const module = await import(
      new URL("./owner-allowance-extension.ts", import.meta.url).href
    )
    const guard = Reflect.apply(
      Reflect.get(module, "registerOwnerAllowance"),
      undefined,
      [host, () => {}],
    )
    t.after(() => guard.dispose())
    const start = callbacks.get("session_start")
    assert.ok(start)
    start({}, ctx)
    assert.deepEqual(saved.at(-1), {
      version: 1,
      lastOwnerAt: 1000,
      deadlineAt: 1000 + 2 * 60 * 60 * 1000,
      status: elapsedMinutes < 120 ? "active" : "expired",
    })
    if (elapsedMinutes < 120) {
      assert.equal(guard.admit()._tag, "Right")
      t.mock.timers.tick((120 - elapsedMinutes) * 60_000)
    }
    const expired = guard.admit()
    assert.equal(expired._tag, "Left")
    assert.match(expired.left.message, /two-hour/)
    assert.equal(aborts, 1)
  })
}

test("authenticated queued input renews only at the native model dispatch boundary", async t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1_000 })
  const callbacks = new Map<string, Function>()
  const authorized = new Set<string>()
  let dispatch: Function | undefined
  const host = {
    on: (name: string, callback: Function) => callbacks.set(name, callback),
    appendEntry: () => {},
    registerCommand: () => {},
    registerModelInputDeliveryGuard: (callback: Function) => {
      dispatch = callback
      return {
        ok: true,
        value: {
          authorizeInput: (id: string) => {
            authorized.add(id)
            return { ok: true, value: undefined }
          },
          isInputAuthorized: (id: string) => authorized.has(id),
        },
      }
    },
  }
  const ctx = {
    abort: () => {},
    ui: { setStatus: () => {}, notify: () => {} },
    sessionManager: { getEntries: () => [] },
  }
  const module = await import(
    new URL("./owner-allowance-extension.ts", import.meta.url).href
  )
  const guard = Reflect.apply(
    Reflect.get(module, "registerOwnerAllowance"),
    undefined,
    [host, () => {}],
  )
  t.after(() => guard.dispose())
  callbacks.get("input")?.(
    {
      source: "interactive",
      text: "queued owner input",
      inputId: "owner-1",
      streamingBehavior: "followUp",
    },
    ctx,
  )
  assert.equal(
    guard.admit()._tag,
    "Left",
    "enqueueing must not grant any work allowance",
  )
  t.mock.timers.tick(300_000)
  assert.ok(dispatch, "the native delivery gate must be registered")
  const decision = Reflect.apply(dispatch, undefined, [
    {
      dispatchId: "dispatch-1",
      dispatchedAt: Date.now(),
      ownerInputIds: ["owner-1"],
    },
    ctx,
  ])
  assert.deepEqual(decision, { action: "allow" })
  const window = guard.admit()
  assert.equal(window._tag, "Right")
  assert.equal(window.right.lastOwnerAt, 301_000)
  assert.equal(window.right.deadlineAt, 301_000 + OWNER_ALLOWANCE_MS)
})

test("delivery-capable host refuses interactive input without a valid native receipt", async t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1_000 })
  const callbacks = new Map<string, Function>()
  const host = {
    on: (name: string, callback: Function) => callbacks.set(name, callback),
    appendEntry: () => {},
    registerCommand: () => {},
    registerModelInputDeliveryGuard: () => ({
      ok: true,
      value: {
        authorizeInput: () => ({
          ok: false,
          error: {
            code: "unknown-input",
            message: "Unknown native input receipt.",
          },
        }),
        isInputAuthorized: () => false,
      },
    }),
  }
  const ctx = { abort: () => {}, ui: { setStatus: () => {}, notify: () => {} } }
  const module = await import(
    new URL("./owner-allowance-extension.ts", import.meta.url).href
  )
  const guard = Reflect.apply(
    Reflect.get(module, "registerOwnerAllowance"),
    undefined,
    [host, () => {}],
  )
  t.after(() => guard.dispose())
  for (const input of [
    { source: "interactive", text: "missing receipt" },
    { source: "interactive", text: "forged receipt", inputId: "forged" },
  ]) {
    const result = callbacks.get("input")?.(input, ctx)
    assert.deepEqual(
      result,
      { action: "handled" },
      "unproven input cannot enter the model queue",
    )
    assert.equal(
      guard.admit()._tag,
      "Left",
      "missing provenance cannot grant a window",
    )
  }
})

test("model dispatch admission does not depend on presentation callbacks", async t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1_000 })
  let dispatch: Function | undefined
  const host = {
    on: () => {},
    appendEntry: () => {},
    registerCommand: () => {},
    registerModelInputDeliveryGuard: (handler: Function) => {
      dispatch = handler
      return {
        ok: true,
        value: {
          authorizeInput: () => ({ ok: true, value: undefined }),
          isInputAuthorized: () => true,
        },
      }
    },
  }
  const ctx = {
    abort: () => {},
    ui: {
      setStatus: () => {
        throw new Error("simulated renderer failure")
      },
      notify: () => {},
    },
  }
  const module = await import(
    new URL("./owner-allowance-extension.ts", import.meta.url).href
  )
  const guard = Reflect.apply(
    Reflect.get(module, "registerOwnerAllowance"),
    undefined,
    [host, () => {}],
  )
  t.after(() => guard.dispose())
  assert.ok(dispatch)
  assert.deepEqual(
    Reflect.apply(dispatch, undefined, [
      {
        dispatchId: "model-1",
        dispatchedAt: Date.now(),
        ownerInputIds: ["owner-1"],
      },
      ctx,
    ]),
    { action: "allow" },
  )
})

test("native expiry integration failure cannot skip foreground cancellation", async t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1_000 })
  const callbacks = new Map<string, Function>()
  let dispatch: Function | undefined
  let aborts = 0
  const host = {
    on: (name: string, callback: Function) => callbacks.set(name, callback),
    appendEntry: () => {},
    registerCommand: () => {},
    registerModelInputDeliveryGuard: (handler: Function) => {
      dispatch = handler
      return {
        ok: true,
        value: {
          authorizeInput: () => ({ ok: true, value: undefined }),
          isInputAuthorized: () => true,
          expireActiveRun: () => {
            throw new Error("simulated host callback failure")
          },
        },
      }
    },
  }
  const ctx = {
    abort: () => {
      aborts++
    },
    ui: { setStatus: () => {}, notify: () => {} },
  }
  const module = await import(
    new URL("./owner-allowance-extension.ts", import.meta.url).href
  )
  const guard = Reflect.apply(
    Reflect.get(module, "registerOwnerAllowance"),
    undefined,
    [host, () => {}],
  )
  t.after(() => guard.dispose())
  assert.ok(dispatch)
  Reflect.apply(dispatch, undefined, [
    {
      dispatchId: "model-1",
      dispatchedAt: Date.now(),
      ownerInputIds: ["owner-1"],
    },
    ctx,
  ])
  const before = aborts
  t.mock.timers.tick(OWNER_ALLOWANCE_MS)
  assert.ok(
    aborts > before,
    "foreground must abort even if the native integration throws",
  )
})

test("real registered hooks enforce tools, provider starts, automation and watchdog cancellation", async t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1_000 })
  const callbacks = new Map<string, Function>()
  const bus = new Map<string, Function>()
  const entries: unknown[] = []
  let aborts = 0
  let workersCancelled = 0
  const host = {
    on: (name: string, callback: Function) => {
      callbacks.set(name, callback)
    },
    events: {
      on: (name: string, callback: Function) => {
        bus.set(name, callback)
      },
    },
    appendEntry: (customType: string, data: unknown) => {
      entries.push({ type: "custom", customType, data })
    },
    registerCommand: () => {},
  }
  const ctx = {
    sessionManager: { getEntries: () => entries },
    abort: () => {
      aborts++
    },
    ui: { setStatus: () => {}, notify: () => {} },
  }
  const module = await import(
    new URL("./owner-allowance-extension.ts", import.meta.url).href
  )
  const install: unknown = Reflect.get(module, "registerOwnerAllowance")
  if (typeof install !== "function")
    assert.fail("Hard deadline hooks are not implemented")
  const privateGuard = Reflect.apply(install, undefined, [
    host,
    () => {
      workersCancelled++
    },
  ])
  const emit = (name: string, event = {}) => {
    const callback = callbacks.get(name)
    if (!callback) assert.fail(`missing actual handler ${name}`)
    return Reflect.apply(callback, undefined, [event, ctx])
  }
  const summary = {
    preparation: {
      targetId: "target",
      oldLeafId: null,
      commonAncestorId: null,
      entriesToSummarize: [],
      userWantsSummary: true,
    },
  }
  emit("session_start")
  assert.deepEqual(emit("session_before_compact"), { cancel: true })
  assert.deepEqual(emit("session_before_tree", summary), { cancel: true })
  assert.equal(
    emit("session_before_tree", {
      preparation: { ...summary.preparation, userWantsSummary: false },
    }),
    undefined,
    "passive history navigation remains available",
  )
  assert.deepEqual(emit("tool_call"), {
    block: true,
    reason:
      "Owner allowance is missing; no execution is admitted without valid owner deadline evidence.",
  })
  emit("input", { source: "extension", text: "continue working" })
  assert.deepEqual(
    emit("input", { source: "extension", text: "new owner instructions" }),
    { action: "handled" },
  )
  assert.equal(entries.length, 0)
  emit("input", { source: "interactive", text: "implement the timer" })
  assert.equal(emit("tool_call"), undefined)
  assert.deepEqual(
    emit("cache_warming_decision"),
    { action: "stop" },
    "the SDK warmer cannot escape via its separate cancellation controller",
  )
  assert.equal(entries.length, 1)
  assert.equal(emit("session_before_compact"), undefined)
  assert.equal(emit("session_before_tree", summary), undefined)
  const before = aborts
  const workersBefore = workersCancelled
  t.mock.timers.tick(OWNER_ALLOWANCE_MS)
  assert.ok(aborts > before, "watchdog must abort without another agent turn")
  assert.ok(workersCancelled > workersBefore, "detached work must be cancelled")
  assert.ok(emit("tool_call"))
  assert.deepEqual(emit("cache_warming_decision"), { action: "stop" })
  const calls = aborts
  emit("before_provider_request", { payload: { fixture: true } })
  assert.ok(aborts > calls)
  emit("input", { source: "rpc", text: "resume" })
  assert.ok(emit("tool_call"), "unauthenticated RPC must not renew")
  emit("session_start")
  assert.ok(emit("tool_call"), "reload must not mint time")
  const images = [{ type: "image", mimeType: "image/png", data: "AA==" }]
  emit("input", { source: "extension", text: "", images })
  assert.ok(emit("tool_call"), "automated attachments cannot renew")
  emit("input", { source: "interactive", text: "", images })
  assert.equal(
    emit("tool_call"),
    undefined,
    "an authenticated image-only owner message renews",
  )
  t.mock.timers.tick(OWNER_ALLOWANCE_MS)
  assert.ok(emit("tool_call"))
  const publicReceipt = bus.get("pi:authenticated-owner-message-received")
  if (publicReceipt)
    Reflect.apply(publicReceipt, undefined, [{ receivedAt: Date.now() }])
  assert.ok(
    emit("tool_call"),
    "public extension events cannot authenticate an owner",
  )
  privateGuard.ownerInput(1_000)
  assert.ok(emit("tool_call"), "old queued owner receipt must not renew")
  privateGuard.ownerInput(Date.now())
  assert.equal(emit("tool_call"), undefined)
  assert.ok(
    entries.some(
      value =>
        typeof value === "object" &&
        value !== null &&
        Reflect.get(value, "customType") === OWNER_ALLOWANCE_ENTRY,
    ),
  )
  emit("session_shutdown")
})
