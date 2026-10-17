import assert from "node:assert/strict"
import test from "node:test"

import { ThrottleActivity } from "./throttle-activity.ts"

test("owner interaction state survives later activity snapshots", () => {
  const activity = new ThrottleActivity()
  activity.ownerInteracted(1_000, 2_000)
  activity.ownerInteracted(900, 2_000)

  assert.equal(activity.snapshot(2_000).ownerInteractionAt, 1_000)
})

test("throttle activity exposes actual admissions, scaling, deferrals, and in-flight calls", () => {
  const activity = new ThrottleActivity()
  activity.providerReserved("call-1", "reviewer", 120_000, 1_000)
  activity.record({
    at: 1_100,
    kind: "workflow",
    outcome: "scaled",
    role: "reviewer",
    requestedTokens: 800_000,
    grantedTokens: 200_000,
  })
  activity.record({
    at: 1_200,
    kind: "turn",
    outcome: "deferred",
    role: "moneymentum-operator",
    retryAt: 61_200,
  })

  assert.deepEqual(activity.snapshot(2_000), {
    windowMs: 900_000,
    inFlightCalls: 1,
    reservedTokens: 120_000,
    counts: {
      admitted: 1,
      deferred: 1,
      scaled: 1,
      settled: 0,
      blocked: 0,
    },
    pausedRoles: [{ role: "moneymentum-operator", retryAt: 61_200 }],
    latest: {
      at: 1_200,
      kind: "turn",
      outcome: "deferred",
      role: "moneymentum-operator",
      retryAt: 61_200,
    },
  })

  activity.providerSettled("call-1", 2_100)
  const settled = activity.snapshot(2_200)
  assert.equal(settled.inFlightCalls, 0)
  assert.equal(settled.reservedTokens, 0)
  assert.equal(settled.counts.settled, 1)
  assert.equal(settled.latest?.outcome, "settled")
})

test("malformed activity cannot invent active calls or counters", () => {
  const activity = new ThrottleActivity()
  activity.providerReserved("", "reviewer", 100, 1)
  activity.providerReserved("call", "", 100, 1)
  activity.providerReserved("call", "reviewer", -1, 1)
  activity.record({
    at: -1,
    kind: "turn",
    outcome: "admitted",
    role: "reviewer",
  })
  assert.deepEqual(activity.snapshot(2), {
    windowMs: 900_000,
    inFlightCalls: 0,
    reservedTokens: 0,
    counts: {
      admitted: 0,
      deferred: 0,
      scaled: 0,
      settled: 0,
      blocked: 0,
    },
    pausedRoles: [],
  })
})

test("a later provider admission clears the role's prior deferral", () => {
  const activity = new ThrottleActivity()
  activity.record({
    at: 1_000,
    kind: "provider-call",
    outcome: "deferred",
    role: "reviewer",
    retryAt: 61_000,
  })
  activity.providerReserved("call-1", "reviewer", 260_426, 2_000)

  assert.deepEqual(activity.snapshot(3_000).pausedRoles, [])
})
