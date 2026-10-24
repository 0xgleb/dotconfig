import assert from "node:assert/strict"
import { Effect, Either } from "effect"
import test from "node:test"
import {
  advanceLoop,
  migrateLegacyReloadLoop,
  nextLoopRunAt,
  parseStoredLoop,
  parseLoopCommand,
  type ActiveLoopState,
} from "./loop.ts"

const active: ActiveLoopState = {
  status: "active",
  instruction: "Complete pending work",
  intervalMs: 60_000,
  startedAt: 1_000,
  nextRunAt: 61_000,
  runs: 0,
}

test("invalid jitter fails through Effect instead of throwing while creating the schedule", () => {
  for (const jitterMs of [NaN, Infinity, -1, 1.5, 60_000]) {
    const effect = nextLoopRunAt({ intervalMs: 60_000, jitterMs }, 1_000)
    const result = Effect.runSync(Effect.either(effect))
    assert.ok(Either.isLeft(result))
    assert.equal(result.left._tag, "LoopCommandError")
  }
})

test("scheduling rejects invalid time, interval, offset and overflowing arithmetic", () => {
  for (const [state, now, offset] of [
    [{ intervalMs: 60_000 }, -1, 0],
    [{ intervalMs: 60_000 }, 1.5, 0],
    [{ intervalMs: 0 }, 1_000, 0],
    [{ intervalMs: 60_000 }, Number.MAX_SAFE_INTEGER, 0],
    [{ intervalMs: 120_000, jitterMs: 60_000 }, 1_000, 60_001],
  ] as const)
    assert.ok(
      Either.isLeft(
        Effect.runSync(Effect.either(nextLoopRunAt(state, now, offset))),
      ),
    )
})

test("loop advancement does not overflow the run counter", () => {
  const result = Effect.runSync(
    Effect.either(
      advanceLoop({ ...active, runs: Number.MAX_SAFE_INTEGER }, 1_000, 0),
    ),
  )
  assert.ok(Either.isLeft(result))
  assert.equal(active.runs, 0)
})

test("persisted scheduler values reject unsafe integers", () => {
  for (const field of ["startedAt", "nextRunAt", "runs", "lastRunAt"])
    assert.equal(
      parseStoredLoop(
        JSON.parse(
          JSON.stringify({ ...active, [field]: Number.MAX_SAFE_INTEGER + 1 }),
        ),
      ),
      undefined,
    )
  assert.deepEqual(parseStoredLoop(JSON.parse(JSON.stringify(active))), active)
})

test("legacy migration rejects malformed or overflowing timestamps", () => {
  for (const now of [-1, NaN, Infinity, Number.MAX_SAFE_INTEGER]) {
    assert.equal(migrateLegacyReloadLoop("1h /reload", now), undefined)
  }
  assert.equal(
    migrateLegacyReloadLoop("1h /reload", 1_000)?.nextRunAt,
    3_601_000,
  )
})

test("valid explicit and sampled jitter remain within the parsed cadence", () => {
  const command = Effect.runSync(
    parseLoopCommand("2m+-1m Complete pending work"),
  )
  assert.equal(command.action, "set")
  if (command.action !== "set") return
  assert.equal(Effect.runSync(nextLoopRunAt(command, 1_000, -60_000)), 61_000)
  assert.equal(Effect.runSync(nextLoopRunAt(command, 1_000, 60_000)), 181_000)
  const sampled = Effect.runSync(nextLoopRunAt(command, 1_000))
  assert.ok(sampled >= 61_000 && sampled <= 181_000)
  assert.equal(Effect.runSync(advanceLoop(active, 1_000, 0)).runs, 1)
})
