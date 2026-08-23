import assert from "node:assert/strict"
import test from "node:test"

import {
  HOUR_MS,
  RELEASE_TARGET_MS,
  dueReleaseCadenceReminder,
  initialReleaseCadenceState,
  nextHourBoundaryAt,
  restoreReleaseCadenceState,
} from "./core.ts"

const at = (iso: string): number => Date.parse(iso)

test("new cadence state starts after the current hour and aligns future boundaries", () => {
  const now = at("2026-07-29T00:07:12Z")
  assert.deepEqual(initialReleaseCadenceState(now), {
    enabled: true,
    lastReminderBoundaryAt: at("2026-07-29T00:00:00Z"),
  })
  assert.equal(nextHourBoundaryAt(now), at("2026-07-29T01:00:00Z"))
})

test("cadence does not fire at quarter-hour boundaries", () => {
  const state = initialReleaseCadenceState(at("2026-07-29T00:31:00Z"))
  assert.equal(
    dueReleaseCadenceReminder(state, at("2026-07-29T00:45:04Z")),
    undefined,
  )
})

test("restoring obsolete quarter-hour state rebases without a late catch-up reminder", () => {
  const restored = restoreReleaseCadenceState(
    {
      enabled: true,
      lastReminderBoundaryAt: at("2026-07-29T00:45:00Z"),
      latestRelease: { version: "v1.10.13", at: at("2026-07-29T00:08:00Z") },
    },
    at("2026-07-29T01:45:04Z"),
  )
  assert.equal(restored.lastReminderBoundaryAt, at("2026-07-29T01:00:00Z"))
  assert.equal(
    dueReleaseCadenceReminder(restored, at("2026-07-29T01:45:04Z")),
    undefined,
  )
  assert.ok(dueReleaseCadenceReminder(restored, at("2026-07-29T02:00:02Z")))
})

test("restoring after a missed hourly boundary skips catch-up and waits for the next hour", () => {
  const restored = restoreReleaseCadenceState(
    {
      enabled: true,
      lastReminderBoundaryAt: at("2026-07-28T23:00:00Z"),
    },
    at("2026-07-29T01:15:00Z"),
  )
  assert.equal(restored.lastReminderBoundaryAt, at("2026-07-29T01:00:00Z"))
  assert.equal(
    dueReleaseCadenceReminder(restored, at("2026-07-29T01:15:00Z")),
    undefined,
  )
})

test("every hourly reminder wakes the operator exactly once", () => {
  const releaseAt = at("2026-07-29T00:01:00Z")
  const state = {
    enabled: true,
    lastReminderBoundaryAt: at("2026-07-29T00:00:00Z"),
    latestRelease: { version: "v1.10.12", at: releaseAt },
    lastTriggeredReleaseAt: releaseAt,
  }
  const due = dueReleaseCadenceReminder(state, at("2026-07-29T01:00:02Z"))
  assert.ok(due)
  assert.equal(due.triggerTurn, true)
  assert.match(due.content, /HOURLY RELEASE CHECK/)
  assert.match(due.content, /three-hour verified-release target/)
  assert.equal(
    dueReleaseCadenceReminder(due.nextState, at("2026-07-29T01:59:59Z")),
    undefined,
  )
})

test("a newly verified live marker is retained by the next hourly wake", () => {
  const state = {
    enabled: true,
    lastReminderBoundaryAt: at("2026-07-29T00:00:00Z"),
    latestRelease: { version: "v1.10.13", at: at("2026-07-29T00:08:00Z") },
    lastTriggeredReleaseAt: at("2026-07-28T23:04:00Z"),
  }
  const due = dueReleaseCadenceReminder(state, at("2026-07-29T01:00:02Z"))
  assert.ok(due)
  assert.equal(due.nextState.lastTriggeredReleaseAt, state.latestRelease.at)
  assert.match(due.content, /v1\.10\.13/)
})

test("hourly wake flags a verified live-release gap over the three-hour target", () => {
  const state = {
    enabled: true,
    lastReminderBoundaryAt: at("2026-07-28T23:00:00Z"),
    latestRelease: { version: "v1.10.11", at: at("2026-07-28T20:59:10Z") },
  }
  const due = dueReleaseCadenceReminder(state, at("2026-07-29T00:00:34Z"))
  assert.ok(due)
  assert.equal(due.cadenceFailure, true)
  assert.match(due.content, /CADENCE FAILURE/)
  assert.match(due.content, /v1\.10\.11/)
  assert.match(due.content, /3h 1m elapsed/)
})

test("disabled cadence never wakes and exact three hours is not a failure", () => {
  const now = at("2026-07-29T01:00:00Z")
  assert.equal(
    dueReleaseCadenceReminder(
      { enabled: false, lastReminderBoundaryAt: now - HOUR_MS },
      now,
    ),
    undefined,
  )
  const due = dueReleaseCadenceReminder(
    {
      enabled: true,
      lastReminderBoundaryAt: now - HOUR_MS,
      latestRelease: { version: "v1.10.12", at: now - RELEASE_TARGET_MS },
    },
    now,
  )
  assert.ok(due)
  assert.equal(due.cadenceFailure, false)
})
