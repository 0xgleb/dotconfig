import assert from "node:assert/strict";
import test from "node:test";

import {
  HOUR_MS,
  QUARTER_HOUR_MS,
  dueReleaseCadenceReminder,
  initialReleaseCadenceState,
  nextQuarterBoundaryAt,
  nextTopOfHourAt,
} from "./core.ts";

const at = (iso: string): number => Date.parse(iso);

test("new cadence state starts after the current quarter and aligns future boundaries", () => {
  const now = at("2026-07-29T00:07:12Z");
  assert.deepEqual(initialReleaseCadenceState(now), {
    enabled: true,
    lastReminderBoundaryAt: at("2026-07-29T00:00:00Z"),
  });
  assert.equal(nextQuarterBoundaryAt(now), at("2026-07-29T00:15:00Z"));
  assert.equal(nextTopOfHourAt(now), at("2026-07-29T01:00:00Z"));
});

test("quarter-hour reminders deliver once and the :45 warning prepares to ship", () => {
  const state = initialReleaseCadenceState(at("2026-07-29T00:31:00Z"));
  const due = dueReleaseCadenceReminder(state, at("2026-07-29T00:45:04Z"));
  assert.ok(due);
  assert.match(due.content, /PREPARE TO SHIP/);
  assert.match(due.content, /2026-07-29T01:00:00\.000Z/);
  assert.equal(dueReleaseCadenceReminder(due.nextState, at("2026-07-29T00:45:59Z")), undefined);
});

test("top-of-hour flags a verified live-release gap over sixty minutes", () => {
  const state = {
    enabled: true,
    lastReminderBoundaryAt: at("2026-07-28T23:45:00Z"),
    latestRelease: { version: "v1.10.11", at: at("2026-07-28T23:00:10.358376Z") },
  };
  const due = dueReleaseCadenceReminder(state, at("2026-07-29T00:00:34Z"));
  assert.ok(due);
  assert.equal(due.cadenceFailure, true);
  assert.match(due.content, /CADENCE FAILURE/);
  assert.match(due.content, /v1\.10\.11/);
  assert.match(due.content, /1h 0m elapsed/);
});

test("disabled cadence never wakes and exact sixty minutes is not a failure", () => {
  const now = at("2026-07-29T01:00:00Z");
  assert.equal(
    dueReleaseCadenceReminder({ enabled: false, lastReminderBoundaryAt: now - QUARTER_HOUR_MS }, now),
    undefined,
  );
  const due = dueReleaseCadenceReminder(
    {
      enabled: true,
      lastReminderBoundaryAt: now - QUARTER_HOUR_MS,
      latestRelease: { version: "v1.10.12", at: now - HOUR_MS },
    },
    now,
  );
  assert.ok(due);
  assert.equal(due.cadenceFailure, false);
});
