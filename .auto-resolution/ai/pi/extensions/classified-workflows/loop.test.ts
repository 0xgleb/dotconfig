import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import {
  advanceLoop,
  DEFAULT_LOOP_INTERVAL_MS,
  formatLoopStatus,
  loopDispatch,
  migrateLegacyReloadLoop,
  migrateReviewDutyLoopCadence,
  nextLoopRunAt,
  parseLoopCommand,
  REVIEW_DUTY_LOOP_JITTER_MS,
  parseStoredLoop,
  type ActiveLoopState,
} from "./loop.ts"

const extensionSource = readFileSync(
  new URL("./index.ts", import.meta.url),
  "utf8",
)

const active: ActiveLoopState = {
  status: "active",
  instruction: "ingest handovers and complete every pending task",
  intervalMs: DEFAULT_LOOP_INTERVAL_MS,
  startedAt: 1_000,
  nextRunAt: 3_601_000,
  runs: 2,
  lastRunAt: 900,
}

test("loop control is available as a typed tool without injecting editor input", () => {
  assert.match(extensionSource, /name: "loop_control"/)
  assert.match(extensionSource, /parseLoopCommand\(params\.args/)
  assert.match(extensionSource, /Scheduled an infinite recurring loop/)
})

test("scheduled loop turns coalesce while one wake is queued or running", () => {
  assert.match(extensionSource, /let loopWakePending = false/)
  assert.match(extensionSource, /if \(loopWakePending \|\| !ctx\.isIdle\(\)\)/)
  assert.match(extensionSource, /loopWakePending = true/)
  assert.match(
    extensionSource,
    /pi\.sendUserMessage\(dispatch\.text, \{ deliverAs: "followUp" \}\)/,
  )
  assert.match(
    extensionSource,
    /pi\.on\("input"[\s\S]*?event\.source === "extension"[\s\S]*?loopWakePending = false/,
  )
})

test("loop defaults to hourly and supports explicit recurring intervals", () => {
  assert.deepEqual(parseLoopCommand(""), { action: "status" })
  assert.deepEqual(parseLoopCommand("status"), { action: "status" })
  assert.deepEqual(parseLoopCommand("STATUS"), { action: "status" })
  assert.deepEqual(parseLoopCommand("clear"), { action: "clear" })
  assert.deepEqual(parseLoopCommand("ingest handovers"), {
    action: "set",
    instruction: "ingest handovers",
    intervalMs: DEFAULT_LOOP_INTERVAL_MS,
  })
  assert.deepEqual(parseLoopCommand("30m check deployments"), {
    action: "set",
    instruction: "check deployments",
    intervalMs: 30 * 60 * 1_000,
  })
  assert.deepEqual(parseLoopCommand("2h review pending tasks"), {
    action: "set",
    instruction: "review pending tasks",
    intervalMs: 2 * 60 * 60 * 1_000,
  })
  assert.deepEqual(parseLoopCommand("1h /register"), {
    action: "set",
    instruction: "/register",
    intervalMs: 60 * 60 * 1_000,
  })
  assert.deepEqual(parseLoopCommand("1h /register 1h"), {
    action: "set",
    instruction: "/register 1h",
    intervalMs: 60 * 60 * 1_000,
  })
  assert.deepEqual(parseLoopCommand("2h+-1h review pending tasks"), {
    action: "set",
    instruction: "review pending tasks",
    intervalMs: 2 * 60 * 60 * 1_000,
    jitterMs: 60 * 60 * 1_000,
  })
  assert.throws(
    () => parseLoopCommand("1h+-1h invalid jitter"),
    /jitter must be smaller/i,
  )
  assert.throws(() => parseLoopCommand("10s spam"), /at least 1 minute/i)
  assert.throws(() => parseLoopCommand("8d too slow"), /at most 7 days/i)
})

test("legacy reload goals migrate at the user's corrected hourly cadence", () => {
  assert.deepEqual(
    migrateLegacyReloadLoop(
      "15m /reload to get latest ~/.config updated",
      5_000,
    ),
    {
      status: "active",
      instruction: "/reload to get latest ~/.config updated",
      intervalMs: DEFAULT_LOOP_INTERVAL_MS,
      startedAt: 5_000,
      nextRunAt: 3_605_000,
      runs: 0,
    },
  )
  assert.equal(migrateLegacyReloadLoop("finish all tests", 5_000), undefined)
  assert.equal(migrateLegacyReloadLoop("/reload once", 5_000), undefined)
})

test("source-fixed review-duty loops migrate to two hours plus or minus one", () => {
  const reviewLoop: ActiveLoopState = {
    ...active,
    instruction:
      "Re-scan ST0x-Technology and rainlanguage PR duty; process newly actionable own and assigned-review work under the loaded repository and review policies, then remain operational.",
    intervalMs: 15 * 60 * 1_000,
    nextRunAt: 100_000,
  }
  assert.deepEqual(migrateReviewDutyLoopCadence(reviewLoop, 5_000, 0), {
    ...reviewLoop,
    intervalMs: 2 * 60 * 60 * 1_000,
    jitterMs: REVIEW_DUTY_LOOP_JITTER_MS,
    nextRunAt: 7_205_000,
  })
  assert.deepEqual(
    migrateReviewDutyLoopCadence(
      { ...reviewLoop, intervalMs: 2 * 60 * 60 * 1_000 },
      5_000,
      REVIEW_DUTY_LOOP_JITTER_MS,
    )?.nextRunAt,
    10_805_000,
  )
  assert.equal(
    migrateReviewDutyLoopCadence(
      { ...reviewLoop, instruction: "Re-scan an unrelated service" },
      5_000,
    ),
    undefined,
  )
  assert.equal(
    migrateReviewDutyLoopCadence(
      { ...reviewLoop, intervalMs: DEFAULT_LOOP_INTERVAL_MS },
      5_000,
    ),
    undefined,
  )
  assert.equal(
    migrateReviewDutyLoopCadence(
      { ...reviewLoop, status: "cleared", finishedAt: 4_000 },
      5_000,
    ),
    undefined,
  )
})

test("infinite loops advance without an achieved terminal state", () => {
  assert.deepEqual(advanceLoop(active, 7_201_000), {
    ...active,
    nextRunAt: 10_801_000,
    runs: 3,
    lastRunAt: 7_201_000,
  })
  const jittered = {
    ...active,
    intervalMs: 2 * 60 * 60 * 1_000,
    jitterMs: 60 * 60 * 1_000,
  }
  assert.equal(nextLoopRunAt(jittered, 1_000, -jittered.jitterMs), 3_601_000)
  assert.equal(nextLoopRunAt(jittered, 1_000, jittered.jitterMs), 10_801_000)
  assert.throws(
    () => nextLoopRunAt(jittered, 1_000, jittered.jitterMs + 1),
    /outside the configured bound/i,
  )
})

test("reload loops dispatch a real runtime command while other loops dispatch prompts", () => {
  assert.deepEqual(loopDispatch({ ...active, instruction: "/reload" }), {
    kind: "command",
    text: "/reload-runtime",
  })
  assert.deepEqual(
    loopDispatch({
      ...active,
      instruction: "/reload to pick up ~/.config changes",
    }),
    {
      kind: "command",
      text: "/reload-runtime",
    },
  )
  assert.deepEqual(loopDispatch(active), {
    kind: "prompt",
    text: "Recurring loop run #2 (infinite):\ningest handovers and complete every pending task",
  })
})

test("stored loops validate all scheduler fields", () => {
  assert.deepEqual(parseStoredLoop(active), active)
  assert.equal(parseStoredLoop({ ...active, intervalMs: 0 }), undefined)
  assert.equal(parseStoredLoop({ ...active, runs: -1 }), undefined)
  assert.equal(
    parseStoredLoop({ ...active, jitterMs: active.intervalMs }),
    undefined,
  )
  assert.equal(parseStoredLoop({ ...active, status: "achieved" }), undefined)
})

test("loop status reports infinite cadence and next run", () => {
  assert.equal(
    formatLoopStatus(undefined, 1_000),
    "No recurring loop has been set in this session.",
  )
  const status = formatLoopStatus(active, 1_801_000)
  assert.match(status, /infinite/i)
  assert.match(status, /every 1h/i)
  assert.match(status, /next in 30m/i)
  assert.match(status, /2 runs/i)
  assert.match(status, /ingest handovers/i)
  assert.match(
    formatLoopStatus(
      { ...active, intervalMs: 2 * 60 * 60 * 1_000, jitterMs: 60 * 60 * 1_000 },
      1_000,
    ),
    /every 2h ± 1h/i,
  )
})
