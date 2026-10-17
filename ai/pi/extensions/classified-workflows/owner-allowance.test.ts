import assert from "node:assert/strict"
import test from "node:test"
import { Either } from "effect"
import * as api from "./owner-allowance.ts"
import type {
  OwnerAllowance,
  OwnerAllowanceRuntime,
  OwnerWindow,
} from "./owner-allowance.ts"

const fixture = (inheritedDeadline?: unknown) => {
  let now = 1_000
  let next = 0
  const callbacks = new Map<number, () => void>()
  const cancelled: string[] = []
  const saved: OwnerWindow[] = []
  const runtime: OwnerAllowanceRuntime<number> = {
    ...(inheritedDeadline === undefined ? {} : { inheritedDeadline }),
    now: () => now,
    schedule: (callback, _delay) => {
      callbacks.set(++next, callback)
      return next
    },
    clear: handle => {
      callbacks.delete(handle)
    },
    persist: window => {
      saved.push(window)
    },
    cancel: error => {
      cancelled.push(error.code)
    },
  }
  const construct: unknown = Reflect.get(api, "createOwnerAllowance")
  if (typeof construct !== "function")
    assert.fail("The harness deadline controller is not implemented")
  const guard: OwnerAllowance = Reflect.apply(construct, undefined, [runtime])
  return {
    runtime,
    guard,
    callbacks,
    cancelled,
    saved,
    time: (value: number) => {
      now = value
    },
  }
}
const code = (result: ReturnType<OwnerAllowance["admit"]>) =>
  Either.match(result, {
    onLeft: error => error.code,
    onRight: () => "allowed",
  })

test("missing owner evidence fails closed instead of starting a fresh allowance", () => {
  const f = fixture()
  assert.equal(code(f.guard.admit()), "missing")
  assert.equal(f.callbacks.size, 0)
})
test("exact 30-minute boundary blocks and latches expiry without changing tasks", () => {
  const f = fixture()
  f.guard.ownerInput(1_000)
  f.time(1_000 + api.OWNER_ALLOWANCE_MS - 1)
  assert.equal(code(f.guard.admit()), "allowed")
  f.time(1_000 + api.OWNER_ALLOWANCE_MS)
  assert.equal(code(f.guard.admit()), "expired")
  f.time(1_001)
  assert.equal(code(f.guard.admit()), "expired")
  assert.deepEqual(f.cancelled, ["expired"])
  assert.equal(f.saved.at(-1)?.status, "expired")
})
test("watchdog cancels even when no model action or next turn occurs", () => {
  const f = fixture()
  f.guard.ownerInput(1_000)
  const fire = [...f.callbacks.values()][0]
  assert.equal(typeof fire, "function")
  fire!()
  assert.deepEqual(f.cancelled, ["expired"])
  assert.equal(code(f.guard.admit()), "expired")
})
test("new owner input renews, but an old timer cannot cancel the new window", () => {
  const f = fixture()
  f.guard.ownerInput(1_000)
  const obsolete = [...f.callbacks.values()][0]
  f.time(2_000)
  f.guard.ownerInput(2_000)
  obsolete!()
  assert.equal(code(f.guard.admit()), "allowed")
  assert.deepEqual(f.cancelled, [])
  assert.equal(f.saved.at(-1)?.deadlineAt, 2_000 + api.OWNER_ALLOWANCE_MS)
})
test("old or duplicate remote receipt timestamps cannot extend the allowance", () => {
  const f = fixture()
  f.guard.ownerInput(1_000)
  f.time(1_100)
  f.guard.ownerInput(999)
  f.guard.ownerInput(1_000)
  assert.equal(f.saved.length, 1)
  assert.equal(f.saved[0]?.deadlineAt, 1_000 + api.OWNER_ALLOWANCE_MS)
})
test("reload restores the original deadline and an expired latch, never now plus 30m", () => {
  const f = fixture()
  f.time(5_000)
  f.guard.restore({
    version: 1,
    lastOwnerAt: 1_000,
    deadlineAt: 1_000 + api.OWNER_ALLOWANCE_MS,
    status: "active",
  })
  assert.equal(code(f.guard.admit()), "allowed")
  assert.equal(f.saved.length, 0)
  f.guard.restore({
    version: 1,
    lastOwnerAt: 1_000,
    deadlineAt: 1_000 + api.OWNER_ALLOWANCE_MS,
    status: "expired",
  })
  assert.equal(code(f.guard.admit()), "expired")
})
test("malformed, future and overflow state cannot mint time", () => {
  for (const snapshot of [
    null,
    {},
    {
      version: 1,
      lastOwnerAt: 1_000,
      deadlineAt: 1_000 + api.OWNER_ALLOWANCE_MS + 1,
      status: "active",
    },
  ]) {
    const f = fixture()
    f.guard.restore(snapshot)
    assert.equal(code(f.guard.admit()), "malformed")
  }
  const f = fixture()
  assert.equal(code(f.guard.ownerInput(Number.NaN)), "invalid-clock")
  assert.equal(code(f.guard.ownerInput(1_001)), "invalid-clock")
  f.time(Number.MAX_SAFE_INTEGER)
  assert.equal(
    code(f.guard.ownerInput(Number.MAX_SAFE_INTEGER)),
    "invalid-clock",
  )
})
test("managed subprocesses are cancelled at expiry and cannot attach after it", () => {
  const f = fixture()
  f.guard.ownerInput(1_000)
  let killed = 0
  const release = f.guard.track(() => {
    killed++
  })
  const done = f.guard.track(() => {
    killed += 100
  })
  done()
  const fire = [...f.callbacks.values()][0]
  fire!()
  assert.equal(killed, 1)
  release()
  f.guard.track(() => {
    killed++
  })
  assert.equal(killed, 2)
})

test("generated child prompts cannot extend the parent's inherited deadline", () => {
  const f = fixture(String(1_000 + api.OWNER_ALLOWANCE_MS))
  f.time(2_000)
  f.guard.ownerInput(2_000)
  assert.equal(f.saved.at(-1)?.deadlineAt, 1_000 + api.OWNER_ALLOWANCE_MS)
  f.time(1_000 + api.OWNER_ALLOWANCE_MS)
  assert.equal(code(f.guard.admit()), "expired")
  for (const bad of ["", "future", "1.5", " 1801000", Number.NaN]) {
    const invalid = fixture(bad)
    invalid.guard.ownerInput(1_000)
    assert.equal(code(invalid.guard.admit()), "malformed")
  }
})

test("persistence and cancellation failures cannot leave other execution running", t => {
  const f = fixture()
  f.guard.ownerInput(1_000)
  let otherWorkerStopped = false
  f.guard.track(() => {
    throw new Error("cancel fixture")
  })
  f.guard.track(() => {
    otherWorkerStopped = true
  })
  t.mock.method(f.runtime, "persist", () => {
    throw new Error("persist fixture")
  })
  const fire = [...f.callbacks.values()][0]
  assert.doesNotThrow(() => fire!())
  assert.equal(otherWorkerStopped, true)
  assert.ok(f.cancelled.length > 0)
  assert.notEqual(code(f.guard.admit()), "allowed")
})

test("dispose removes the watchdog without granting a replacement window", () => {
  const f = fixture()
  f.guard.ownerInput(1_000)
  f.guard.dispose()
  assert.equal(f.callbacks.size, 0)
  assert.equal(code(f.guard.admit()), "closed")
  assert.deepEqual(f.cancelled, ["closed"])
})
