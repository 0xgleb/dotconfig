import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { Effect } from "effect"
import {
  advanceLoop as advanceLoopEffect,
  DEFAULT_LOOP_INTERVAL_MS,
  formatLoopStatus,
  loopDispatch,
  nextLoopRunAt as nextLoopRunAtEffect,
  parseLoopCommand as parseLoopCommandEffect,
  parseStoredLoop,
  type ActiveLoopState,
} from "./loop.ts"

const advanceLoop = (...args: Parameters<typeof advanceLoopEffect>) =>
  Effect.runSync(advanceLoopEffect(...args))
const nextLoopRunAt = (...args: Parameters<typeof nextLoopRunAtEffect>) =>
  Effect.runSync(nextLoopRunAtEffect(...args))
const parseLoopCommand = (...args: Parameters<typeof parseLoopCommandEffect>) =>
  Effect.runSync(parseLoopCommandEffect(...args))

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
  assert.match(
    extensionSource,
    /if \(loopWakePending \|\| !ctx\.isIdle\(\) \|\| continuationPaused\)/,
  )
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

test("explicit cadence preserves the complete multiline instruction", () => {
  for (const separator of ["\n", "\r\n", "\u2028", "\u2029"]) {
    const instruction = `/register${separator}Include bounded alert intake`
    assert.deepEqual(parseLoopCommand(`5m ${instruction}`), {
      action: "set",
      instruction,
      intervalMs: 5 * 60 * 1_000,
    })
    assert.deepEqual(parseLoopCommand(`2h+-1h ${instruction}`), {
      action: "set",
      instruction,
      intervalMs: 2 * 60 * 60 * 1_000,
      jitterMs: 60 * 60 * 1_000,
    })
    assert.deepEqual(parseLoopCommand(instruction), {
      action: "set",
      instruction,
      intervalMs: DEFAULT_LOOP_INTERVAL_MS,
    })
  }
})

test("multiline instructions cannot bypass interval and jitter validation", () => {
  for (const [cadence, error] of [
    ["10s", /at least 1 minute/i],
    ["8d", /at most 7 days/i],
    ["1h+-1h", /jitter must be smaller/i],
    ["2h+-10s", /at least 1 minute/i],
  ] as const) {
    assert.throws(
      () =>
        parseLoopCommand(`${cadence} /register\nInclude bounded alert intake`),
      error,
    )
  }
})

test("multiline instruction length excludes the parsed cadence prefix", () => {
  const instruction = `/register\n${"a".repeat(3_990)}`
  assert.deepEqual(parseLoopCommand(`5m ${instruction}`), {
    action: "set",
    instruction,
    intervalMs: 5 * 60 * 1_000,
  })
  assert.throws(
    () => parseLoopCommand(`5m ${instruction}a`),
    /at most 4,000 characters/i,
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
