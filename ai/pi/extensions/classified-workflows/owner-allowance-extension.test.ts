import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { OWNER_ALLOWANCE_ENTRY, OWNER_ALLOWANCE_MS } from "./owner-allowance.ts"

test("production entrypoint installs the hard deadline guard and cancels detached workers", () => {
  const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8")
  assert.ok(
    /registerOwnerAllowance\(pi/.test(source),
    "production must install the guard",
  )
  assert.ok(
    /ownerAllowance\.admit\(\)/.test(source),
    "continuations must check the deadline",
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
  emit("session_start")
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
