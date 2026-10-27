import assert from "node:assert/strict"
import test from "node:test"
import { Either } from "effect"
import * as api from "./owner-allowance.ts"
import type {
  OwnerAllowance,
  OwnerAllowanceRuntime,
  OwnerWindow,
} from "./owner-allowance.ts"

const fixture = (
  inheritedDeadline?: unknown,
  onProgressCheckIn?: OwnerAllowanceRuntime<number>["onProgressCheckIn"],
) => {
  let now = 1_000
  let next = 0
  const callbacks = new Map<number, () => void>()
  const delays = new Map<number, number>()
  const cancelled: string[] = []
  const saved: OwnerWindow[] = []
  const expired: OwnerWindow[] = []
  const runtime: OwnerAllowanceRuntime<number> = {
    ...(inheritedDeadline === undefined ? {} : { inheritedDeadline }),
    ...(onProgressCheckIn === undefined ? {} : { onProgressCheckIn }),
    now: () => now,
    schedule: (callback, delay) => {
      callbacks.set(++next, callback)
      delays.set(next, delay)
      return next
    },
    clear: handle => {
      callbacks.delete(handle)
      delays.delete(handle)
    },
    persist: window => {
      saved.push(window)
    },
    cancel: error => {
      cancelled.push(error.code)
    },
    onExpired: window => expired.push(window),
  }
  const construct: unknown = Reflect.get(api, "createOwnerAllowance")
  if (typeof construct !== "function")
    assert.fail("The harness deadline controller is not implemented")
  const guard: OwnerAllowance = Reflect.apply(construct, undefined, [runtime])
  return {
    runtime,
    guard,
    callbacks,
    delays,
    cancelled,
    saved,
    expired,
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

for (const supervised of [false, true]) {
  test(`authenticated owner input grants a flat two-hour window: supervised=${supervised}`, () => {
    const f = fixture(
      undefined,
      supervised ? () => Either.right(undefined) : undefined,
    )
    const twoHours = 2 * 60 * 60 * 1000
    assert.equal(api.OWNER_ALLOWANCE_MS, twoHours)
    assert.equal(api.SUPERVISED_OWNER_ALLOWANCE_MS, twoHours)
    assert.equal(code(f.guard.ownerInput(1000)), "allowed")
    assert.equal(f.saved.at(-1)?.deadlineAt, 1000 + twoHours)
    f.time(1000 + twoHours - 1)
    assert.equal(code(f.guard.admit()), "allowed")
    f.time(1000 + twoHours)
    const expired = f.guard.admit()
    assert.equal(code(expired), "expired")
    assert.ok(Either.isLeft(expired))
    assert.match(expired.left.message, /two-hour/)
  })

  for (const legacy of [
    { duration: 30, elapsed: 10, status: "active", allowed: true },
    { duration: 60, elapsed: 10, status: "active", allowed: true },
    { duration: 240, elapsed: 90, status: "active", allowed: true },
    { duration: 180, elapsed: 90, status: "active", allowed: true },
    { duration: 120, elapsed: 90, status: "active", allowed: true },
    { duration: 240, elapsed: 150, status: "active", allowed: false },
    { duration: 60, elapsed: 70, status: "active", allowed: false },
    { duration: 240, elapsed: 90, status: "expired", allowed: false },
  ] as const) {
    test(`historical ${legacy.duration}m/${legacy.status} snapshot at ${legacy.elapsed}m: supervised=${supervised}`, () => {
      const f = fixture(
        undefined,
        supervised ? () => Either.right(undefined) : undefined,
      )
      f.time(1000 + legacy.elapsed * 60_000)
      f.guard.restore({
        version: 1,
        lastOwnerAt: 1000,
        deadlineAt: 1000 + legacy.duration * 60_000,
        status: legacy.status,
      })
      const admitted = f.guard.admit()
      assert.equal(code(admitted), legacy.allowed ? "allowed" : "expired")
      if (legacy.allowed) {
        assert.ok(Either.isRight(admitted))
        assert.equal(admitted.right.lastOwnerAt, 1000)
        assert.equal(admitted.right.deadlineAt, 1000 + 120 * 60_000)
        if (legacy.duration === 120) assert.equal(f.saved.length, 0)
      } else {
        assert.ok(f.saved.every(window => window.status === "expired"))
      }
    })
  }
}

test("historical window migration clips the two-hour policy to the inherited absolute ceiling", () => {
  const ceiling = 1000 + 45 * 60_000
  const f = fixture(String(ceiling))
  f.time(1000 + 10 * 60_000)
  f.guard.restore({
    version: 1,
    lastOwnerAt: 1000,
    deadlineAt: 1000 + 30 * 60_000,
    status: "active",
  })
  const admitted = f.guard.admit()
  assert.ok(Either.isRight(admitted))
  assert.equal(admitted.right.deadlineAt, ceiling)
  assert.equal(f.saved.at(-1)?.lastOwnerAt, 1000)
  f.time(ceiling)
  assert.equal(code(f.guard.admit()), "expired")
})

test("policy upgrade extends an unexpired legacy window from its authenticated timestamp, not reload time", () => {
  const f = fixture()
  f.time(5000)
  f.guard.restore({
    version: 1,
    lastOwnerAt: 1000,
    deadlineAt: 1000 + 30 * 60 * 1000,
    status: "active",
  })
  assert.equal(code(f.guard.admit()), "allowed")
  assert.equal(f.saved.at(-1)?.lastOwnerAt, 1000)
  assert.equal(f.saved.at(-1)?.deadlineAt, 1000 + 2 * 60 * 60 * 1000)
})

test("policy upgrade cannot extend a legacy child's inherited parent deadline", () => {
  const started = 10_000_000
  const deadlineAt = started + 30 * 60 * 1000
  const f = fixture(String(deadlineAt))
  f.time(started + 1000)
  f.guard.restore({
    version: 1,
    lastOwnerAt: started,
    deadlineAt,
    status: "active",
  })
  assert.equal(code(f.guard.admit()), "allowed")
  assert.equal(f.saved.length, 0)
  f.time(deadlineAt)
  assert.equal(code(f.guard.admit()), "expired")
})

test("the two-hour policy does not revive expired legacy rounds", () => {
  for (const status of ["active", "expired"] as const) {
    const f = fixture()
    f.time(1000 + 30 * 60 * 1000)
    f.guard.restore({
      version: 1,
      lastOwnerAt: 1000,
      deadlineAt: 1000 + 30 * 60 * 1000,
      status,
    })
    assert.equal(code(f.guard.admit()), "expired")
  }
})

test("missing owner evidence fails closed instead of starting a fresh allowance", () => {
  const f = fixture()
  assert.equal(code(f.guard.admit()), "missing")
  assert.equal(f.callbacks.size, 0)
})
test("exact two-hour boundary blocks and latches expiry without changing tasks", () => {
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
test("reload restores the original deadline and an expired latch, never now plus two hours", () => {
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
      deadlineAt: 1_000 + 4 * 60 * 60 * 1000 + 1,
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

test("supervision grants two hours and schedules check-ins without renewing the owner clock", () => {
  const requests: api.OwnerProgressCheckIn[] = []
  const f = fixture(undefined, request => {
    requests.push(request)
    return Either.right(undefined)
  })
  f.guard.ownerInput(1000)
  assert.equal(f.saved.at(-1)?.deadlineAt, 1000 + 2 * 60 * 60 * 1000)
  assert.equal(f.callbacks.size, 2)
  assert.deepEqual(
    [...f.delays.values()],
    [api.SUPERVISED_OWNER_ALLOWANCE_MS, api.OWNER_PROGRESS_CHECK_IN_MS],
  )
  f.time(1000 + api.OWNER_PROGRESS_CHECK_IN_MS)
  const check = [...f.callbacks.values()].at(-1)
  if (!check) assert.fail("Missing progress check-in timer")
  check()
  assert.equal(requests.length, 1)
  assert.equal([...f.delays.values()].at(-1), api.OWNER_PROGRESS_CHECK_IN_MS)
  assert.equal(requests[0]?.sequence, 1)
  assert.equal(requests[0]?.scheduledAt, 1000 + api.OWNER_PROGRESS_CHECK_IN_MS)
  assert.equal(f.saved.length, 1)
  assert.equal(f.saved[0]?.lastOwnerAt, 1000)
  f.time(1000 + 2 * 60 * 60 * 1000)
  assert.equal(code(f.guard.admit()), "expired")
})

test("a supervised legacy upgrade preserves its original owner timestamp and never revives expiry", () => {
  for (const duration of [30 * 60 * 1000, 60 * 60 * 1000]) {
    const f = fixture(undefined, () => Either.right(undefined))
    f.time(5000)
    f.guard.restore({
      version: 1,
      lastOwnerAt: 1000,
      deadlineAt: 1000 + duration,
      status: "active",
    })
    assert.equal(f.saved.at(-1)?.deadlineAt, 1000 + 2 * 60 * 60 * 1000)
    assert.equal(f.saved.at(-1)?.lastOwnerAt, 1000)
    const expired = fixture(undefined, () => Either.right(undefined))
    expired.time(1000 + duration)
    expired.guard.restore({
      version: 1,
      lastOwnerAt: 1000,
      deadlineAt: 1000 + duration,
      status: "active",
    })
    assert.equal(code(expired.guard.admit()), "expired")
  }
})

test("an inherited ceiling preserves the actual owner timestamp and survives reload", () => {
  const start = 100_000_000
  const ceiling = start + 45 * 60 * 1000
  const f = fixture(String(ceiling), () => Either.right(undefined))
  f.time(start)
  f.guard.ownerInput(start)
  assert.equal(f.saved.at(-1)?.deadlineAt, ceiling)
  assert.equal(f.saved.at(-1)?.lastOwnerAt, start)
  const restored = fixture(String(ceiling), () => Either.right(undefined))
  restored.time(start + 1000)
  restored.guard.restore(f.saved.at(-1))
  assert.equal(code(restored.guard.admit()), "allowed")
  restored.time(ceiling)
  assert.equal(code(restored.guard.admit()), "expired")
})

const progressTimer = (f: ReturnType<typeof fixture>) => {
  const fire = [...f.callbacks.values()].at(-1)
  if (!fire) throw new Error("Missing progress check-in timer")
  return fire
}

test("an early check-in timer cannot request review before its scheduled boundary", () => {
  const requests: api.OwnerProgressCheckIn[] = []
  const f = fixture(undefined, request => {
    requests.push(request)
    return Either.right(undefined)
  })
  f.guard.ownerInput(1000)
  progressTimer(f)()
  assert.equal(requests.length, 0)
  assert.equal([...f.delays.values()].at(-1), api.OWNER_PROGRESS_CHECK_IN_MS)
  f.time(1000 + api.OWNER_PROGRESS_CHECK_IN_MS)
  progressTimer(f)()
  assert.equal(requests.length, 1)
})

test("obsolete check-in callbacks cannot act after renewal or disposal", () => {
  const requests: api.OwnerProgressCheckIn[] = []
  const f = fixture(undefined, request => {
    requests.push(request)
    return Either.right(undefined)
  })
  f.guard.ownerInput(1000)
  const old = progressTimer(f)
  f.time(2000)
  f.guard.ownerInput(2000)
  old()
  assert.equal(requests.length, 0)
  const current = progressTimer(f)
  f.guard.dispose()
  current()
  assert.equal(requests.length, 0)
  assert.equal(f.callbacks.size, 0)
})

test("two-hour supervision checks in at 30, 60 and 90 minutes without renewing or scheduling a 120-minute check-in", () => {
  const requests: api.OwnerProgressCheckIn[] = []
  const f = fixture(undefined, request => {
    requests.push(request)
    return Either.right(undefined)
  })
  f.guard.ownerInput(1000)
  for (const sequence of [1, 2, 3]) {
    f.time(1000 + sequence * api.OWNER_PROGRESS_CHECK_IN_MS)
    progressTimer(f)()
  }
  assert.deepEqual(
    requests.map(request => request.sequence),
    [1, 2, 3],
  )
  assert.ok(
    requests.every(
      request =>
        request.window.lastOwnerAt === 1000 &&
        request.window.deadlineAt === 1000 + api.OWNER_ALLOWANCE_MS,
    ),
  )
  assert.equal(f.callbacks.size, 1)
  assert.equal(f.saved.length, 1)
  f.time(1000 + api.OWNER_ALLOWANCE_MS)
  assert.equal(code(f.guard.admit()), "expired")
  assert.equal(requests.length, 3)
})

test("delayed and restored check-ins use a stable coalesced interval identity", () => {
  const requests: api.OwnerProgressCheckIn[] = []
  const f = fixture(undefined, request => {
    requests.push(request)
    return Either.right(undefined)
  })
  f.guard.ownerInput(1000)
  const delayed = progressTimer(f)
  f.time(1000 + 3 * api.OWNER_PROGRESS_CHECK_IN_MS)
  delayed()
  delayed()
  assert.deepEqual(
    requests.map(request => request.sequence),
    [3],
  )
  assert.equal(f.callbacks.size, 1)
  const restored = fixture(undefined, request => {
    requests.push(request)
    return Either.right(undefined)
  })
  restored.time(1000 + 3 * api.OWNER_PROGRESS_CHECK_IN_MS)
  restored.guard.restore(f.saved[0])
  assert.equal([...restored.delays.values()].at(-1), 0)
  progressTimer(restored)()
  assert.equal(restored.callbacks.size, 1)
  assert.equal(
    [...restored.delays.values()].at(-1),
    api.OWNER_ALLOWANCE_MS - 3 * api.OWNER_PROGRESS_CHECK_IN_MS,
  )
  assert.equal(requests[0]?.scheduledAt, requests[1]?.scheduledAt)
  assert.equal(requests[0]?.window.lastOwnerAt, requests[1]?.window.lastOwnerAt)
  assert.equal(f.saved.length, 1)
})

test("a late callback cannot submit review after the two-hour deadline", () => {
  let requests = 0
  const f = fixture(undefined, () => {
    requests++
    return Either.right(undefined)
  })
  f.guard.ownerInput(1000)
  const pending = progressTimer(f)
  f.time(1000 + api.SUPERVISED_OWNER_ALLOWANCE_MS)
  pending()
  assert.equal(requests, 0)
  assert.equal(code(f.guard.admit()), "expired")
  assert.equal(f.callbacks.size, 0)
})

test("callback failures and malformed acknowledgements remain typed failures", () => {
  const callbacks: OwnerAllowanceRuntime<number>["onProgressCheckIn"][] = [
    () => {
      throw new Error("Fixture callback failure")
    },
    () =>
      Either.left(
        new api.OwnerAllowanceError({
          code: "runtime-failure",
          message: "Fixture queue unavailable",
        }),
      ),
    (() => undefined) as unknown as NonNullable<
      OwnerAllowanceRuntime<number>["onProgressCheckIn"]
    >,
    (() => Either.right("not an acknowledgement")) as unknown as NonNullable<
      OwnerAllowanceRuntime<number>["onProgressCheckIn"]
    >,
    (() => Either.left("not a domain error")) as unknown as NonNullable<
      OwnerAllowanceRuntime<number>["onProgressCheckIn"]
    >,
  ]
  for (const callback of callbacks) {
    const f = fixture(undefined, callback)
    f.guard.ownerInput(1000)
    f.time(1000 + api.OWNER_PROGRESS_CHECK_IN_MS)
    assert.doesNotThrow(progressTimer(f))
    assert.notEqual(code(f.guard.admit()), "allowed")
    assert.equal(f.callbacks.size, 0)
  }
})

test("a callback cannot mutate the live owner window or stop a renewed window", () => {
  const f: ReturnType<typeof fixture> = fixture(undefined, request => {
    Reflect.set(request.window, "deadlineAt", Number.MAX_SAFE_INTEGER)
    f.time(1000 + api.OWNER_PROGRESS_CHECK_IN_MS + 1)
    f.guard.ownerInput(1000 + api.OWNER_PROGRESS_CHECK_IN_MS + 1)
    return Either.left(
      new api.OwnerAllowanceError({
        code: "runtime-failure",
        message: "Obsolete request failed",
      }),
    )
  })
  f.guard.ownerInput(1000)
  f.time(1000 + api.OWNER_PROGRESS_CHECK_IN_MS)
  progressTimer(f)()
  assert.equal(code(f.guard.admit()), "allowed")
  assert.equal(
    f.saved.at(-1)?.deadlineAt,
    1000 +
      api.OWNER_PROGRESS_CHECK_IN_MS +
      1 +
      api.SUPERVISED_OWNER_ALLOWANCE_MS,
  )
  assert.equal(f.callbacks.size, 2)
})

test("throwing acknowledgement accessors cannot escape or leave supervision silently disabled", () => {
  for (const side of ["right", "left", "code"] as const) {
    const f = fixture(undefined, () => {
      const fail = () => {
        throw new Error("Fixture accessor failure")
      }
      if (side === "right")
        return Object.defineProperty(Either.right(undefined), "right", {
          get: fail,
        })
      const cause = new api.OwnerAllowanceError({
        code: "runtime-failure",
        message: "Fixture error",
      })
      if (side === "code")
        return Either.left(Object.defineProperty(cause, "code", { get: fail }))
      return Object.defineProperty(Either.left(cause), "left", { get: fail })
    })
    f.guard.ownerInput(1000)
    f.time(1000 + api.OWNER_PROGRESS_CHECK_IN_MS)
    assert.doesNotThrow(progressTimer(f))
    assert.equal(code(f.guard.admit()), "runtime-failure")
    assert.equal(f.callbacks.size, 0)
  }
})

test("reentrant acknowledgement accessors cannot replace a renewed window's timer", () => {
  const f: ReturnType<typeof fixture> = fixture(undefined, () =>
    Object.defineProperty(Either.right(undefined), "right", {
      get: () => {
        f.time(1000 + api.OWNER_PROGRESS_CHECK_IN_MS + 1)
        f.guard.ownerInput(1000 + api.OWNER_PROGRESS_CHECK_IN_MS + 1)
        return undefined
      },
    }),
  )
  f.guard.ownerInput(1000)
  f.time(1000 + api.OWNER_PROGRESS_CHECK_IN_MS)
  progressTimer(f)()
  assert.equal(code(f.guard.admit()), "allowed")
  assert.equal(f.callbacks.size, 2)
  assert.equal([...f.delays.values()].at(-1), api.OWNER_PROGRESS_CHECK_IN_MS)
})

test("watchdog scheduling failure is typed and cancels already tracked work", t => {
  const f = fixture(undefined, () => Either.right(undefined))
  f.guard.ownerInput(1000)
  let cancelled = 0
  f.guard.track(() => {
    cancelled++
  })
  t.mock.method(f.runtime, "schedule", () => {
    throw new Error("Fixture scheduler unavailable")
  })
  f.time(2000)
  assert.doesNotThrow(() => f.guard.ownerInput(2000))
  assert.equal(code(f.guard.admit()), "runtime-failure")
  assert.equal(cancelled, 1)
  assert.equal(f.callbacks.size, 0)
})

test("throwing restoration getters cannot remove protection without cancelling work", () => {
  for (const property of [
    "version",
    "lastOwnerAt",
    "deadlineAt",
    "status",
  ] as const) {
    const f = fixture(undefined, () => Either.right(undefined))
    f.guard.ownerInput(1000)
    let cancelled = 0
    f.guard.track(() => {
      cancelled++
    })
    const snapshot = { ...f.saved[0] }
    Object.defineProperty(snapshot, property, {
      get: () => {
        throw new Error("Fixture snapshot accessor")
      },
    })
    assert.doesNotThrow(() => f.guard.restore(snapshot))
    assert.equal(cancelled, 1)
    assert.equal(code(f.guard.admit()), "malformed")
    assert.equal(f.callbacks.size, 0)
  }
})

test("obsolete expiry cannot persist or report a renewed active window as expired", () => {
  for (const throwsAfterRenewal of [false, true]) {
    const f = fixture(undefined, () => Either.right(undefined))
    f.guard.ownerInput(1000)
    const expiry = [...f.callbacks.values()][0]
    if (!expiry) throw new Error("Missing expiry watchdog")
    f.guard.track(() => {
      f.time(1000 + api.SUPERVISED_OWNER_ALLOWANCE_MS + 1)
      f.guard.ownerInput(1000 + api.SUPERVISED_OWNER_ALLOWANCE_MS + 1)
      if (throwsAfterRenewal) throw new Error("Obsolete cancellation failed")
    })
    f.time(1000 + api.SUPERVISED_OWNER_ALLOWANCE_MS)
    expiry()
    assert.equal(code(f.guard.admit()), "allowed")
    assert.equal(f.saved.at(-1)?.status, "active")
    assert.equal(
      f.saved.at(-1)?.lastOwnerAt,
      1000 + api.SUPERVISED_OWNER_ALLOWANCE_MS + 1,
    )
    assert.ok(
      f.expired.every(
        window => window.status === "expired" && window.lastOwnerAt === 1000,
      ),
    )
    assert.equal(f.callbacks.size, 2)
  }
})

test("restoration accessors cannot revive a scope disposed during decoding", () => {
  const f = fixture(undefined, () => Either.right(undefined))
  f.guard.ownerInput(1000)
  const snapshot = { ...f.saved[0] }
  Object.defineProperty(snapshot, "version", {
    get: () => {
      f.guard.dispose()
      return 1
    },
  })
  f.guard.restore(snapshot)
  assert.equal(code(f.guard.admit()), "closed")
  assert.equal(f.callbacks.size, 0)
})

test("the supervised watchdog cancels tracked work at its actual two-hour deadline", () => {
  const f = fixture(undefined, () => Either.right(undefined))
  f.guard.ownerInput(1000)
  let cancelled = 0
  f.guard.track(() => {
    cancelled++
  })
  const expiry = [...f.callbacks.values()][0]
  if (!expiry) throw new Error("Missing expiry watchdog")
  f.time(1000 + api.SUPERVISED_OWNER_ALLOWANCE_MS)
  expiry()
  assert.equal(cancelled, 1)
  assert.equal(f.expired.length, 1)
  assert.equal(f.expired[0]?.status, "expired")
  assert.equal(code(f.guard.admit()), "expired")
  assert.equal(f.callbacks.size, 0)
})

test("persistence and public window snapshots cannot alter the canonical parent ceiling", t => {
  const start = 100_000_000
  const ceiling = start + 45 * 60 * 1000
  const f = fixture(String(ceiling), () => Either.right(undefined))
  t.mock.method(f.runtime, "persist", (snapshot: OwnerWindow) => {
    Reflect.set(snapshot, "deadlineAt", start + 8 * 60 * 60 * 1000)
    f.saved.push(snapshot)
  })
  f.time(start)
  const granted = f.guard.ownerInput(start)
  if (Either.isLeft(granted)) throw new Error("Fixture grant failed")
  Reflect.set(granted.right, "deadlineAt", start + 8 * 60 * 60 * 1000)
  const admitted = f.guard.admit()
  if (Either.isLeft(admitted)) throw new Error("Fixture admission failed")
  Reflect.set(admitted.right, "deadlineAt", start + 8 * 60 * 60 * 1000)
  assert.equal([...f.delays.values()][0], 45 * 60 * 1000)
  f.time(ceiling)
  assert.equal(code(f.guard.admit()), "expired")
})

test("disposal during a clock read denies and cancels newly tracked work", t => {
  const f = fixture(undefined, () => Either.right(undefined))
  f.guard.ownerInput(1000)
  t.mock.method(f.runtime, "now", () => {
    f.guard.dispose()
    return 1000
  })
  let cancelled = 0
  f.guard.track(() => {
    cancelled++
  })
  assert.equal(cancelled, 1)
  assert.equal(code(f.guard.admit()), "closed")
  assert.equal(f.callbacks.size, 0)
})

test("clock callbacks cannot send a progress request after disposal or renewal", t => {
  for (const change of ["dispose", "renew"] as const) {
    const requests: api.OwnerProgressCheckIn[] = []
    const f = fixture(undefined, request => {
      requests.push(request)
      return Either.right(undefined)
    })
    f.guard.ownerInput(1000)
    f.time(1000 + api.OWNER_PROGRESS_CHECK_IN_MS)
    const now = f.runtime.now
    let calls = 0
    const mocked = t.mock.method(f.runtime, "now", () => {
      if (++calls === 2) {
        if (change === "dispose") f.guard.dispose()
        else {
          f.time(1000 + api.OWNER_PROGRESS_CHECK_IN_MS + 1)
          f.guard.ownerInput(now())
        }
      }
      return now()
    })
    progressTimer(f)()
    mocked.mock.restore()
    assert.equal(requests.length, 0)
    assert.equal(
      code(f.guard.admit()),
      change === "dispose" ? "closed" : "allowed",
    )
  }
})

test("proxy callback returns cannot escape or leave an admitted window without timers", t => {
  const f = fixture(undefined, () => Either.right(undefined))
  f.guard.ownerInput(1000)
  let cancelled = 0
  f.guard.track(() => {
    cancelled++
  })
  t.mock.method(
    f.runtime,
    "persist",
    () =>
      new Proxy(
        {},
        {
          getPrototypeOf: () => {
            throw new Error("Fixture prototype trap")
          },
        },
      ),
  )
  f.time(2000)
  assert.doesNotThrow(() => f.guard.ownerInput(2000))
  assert.equal(code(f.guard.admit()), "runtime-failure")
  assert.equal(cancelled, 1)
  assert.equal(f.callbacks.size, 0)
})

test("dispose removes the watchdog without granting a replacement window", () => {
  const f = fixture()
  f.guard.ownerInput(1_000)
  f.guard.dispose()
  assert.equal(f.callbacks.size, 0)
  assert.equal(code(f.guard.admit()), "closed")
  assert.deepEqual(f.cancelled, ["closed"])
})
