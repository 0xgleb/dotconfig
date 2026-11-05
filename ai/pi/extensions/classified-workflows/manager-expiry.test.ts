import assert from "node:assert/strict"
import test from "node:test"
import { Either } from "effect"
import {
  createOwnerAllowance,
  OWNER_ALLOWANCE_MS,
  type OwnerWindow,
} from "./owner-allowance.ts"

test("only actual worker expiry emits a private once-per-round summary opportunity", () => {
  let now = 1000
  let timer: (() => void) | undefined
  const order: string[] = []
  const windows: OwnerWindow[] = []
  const guard = createOwnerAllowance({
    now: () => now,
    schedule: callback => {
      timer = callback
      return callback
    },
    clear: () => {},
    persist: window => {
      if (window.status === "expired") order.push("persist")
    },
    cancel: () => {
      order.push("cancel")
    },
    onExpired: window => {
      windows.push(window)
      order.push("summary")
    },
  })
  assert.ok(Either.isRight(guard.ownerInput(now)))
  now += OWNER_ALLOWANCE_MS
  timer?.()
  guard.admit()
  guard.dispose()
  assert.equal(windows.length, 1)
  assert.equal(windows[0]?.deadlineAt, now)
  assert.deepEqual(order.slice(0, 3), ["persist", "cancel", "summary"])
})

test("shutdown, malformed state and already-expired restoration cannot start another summary", () => {
  let summaries = 0
  const runtime = {
    now: () => OWNER_ALLOWANCE_MS + 1,
    schedule: () => 0,
    clear: () => {},
    persist: () => {},
    cancel: () => {},
    onExpired: () => {
      summaries += 1
    },
  }
  const guard = createOwnerAllowance(runtime)
  guard.restore({
    version: 1,
    lastOwnerAt: 0,
    deadlineAt: OWNER_ALLOWANCE_MS,
    status: "expired",
  })
  guard.dispose()
  guard.restore({ version: 99 })
  assert.equal(summaries, 0)
})
