import assert from "node:assert/strict"
import test from "node:test"
import { Effect, Either } from "effect"
import {
  cancelJob,
  claimJob,
  completeJob,
  createJob,
  decodeJobSpec,
  failJob,
  recoverExpiredJob,
  type Job,
  type RegisteredJobSpec,
} from "./job-runtime.ts"

const reviewSpec: RegisteredJobSpec = {
  kind: "review-duty.scan",
  payload: { profile: "st0x-review" },
  runAt: 2_000,
  maxAttempts: 3,
  recurrence: { baseMs: 2 * 60 * 60 * 1_000, jitterMs: 60 * 60 * 1_000 },
  idempotencyKey: "review-duty:st0x-review",
}

const run = <A>(effect: Effect.Effect<A, unknown>): A => Effect.runSync(effect)

const errorCode = <A>(effect: Effect.Effect<A, unknown>): string | undefined => {
  const result = Effect.runSync(Effect.either(effect))
  if (Either.isRight(result)) return undefined
  const error = result.left
  return typeof error === "object" && error !== null && "code" in error
    ? String(error.code)
    : undefined
}

const readyJob = (): Job =>
  run(createJob({ ...reviewSpec, runAt: 1_000 }, "job-1", 1_000))

const leasedJob = (): Job =>
  run(claimJob(readyJob(), "worker-a", "lease-a", 1_000, 90_000))

test("the untrusted enqueue boundary accepts only registered bounded job payloads", () => {
  assert.deepEqual(
    run(decodeJobSpec(reviewSpec)),
    reviewSpec,
  )
  assert.equal(
    errorCode(
      decodeJobSpec({
        ...reviewSpec,
        kind: "shell.run",
        payload: { command: "arbitrary command" },
      }),
    ),
    "invalid_input",
  )
  assert.equal(
    errorCode(
      decodeJobSpec({
        ...reviewSpec,
        payload: { profile: "unknown-review" },
      }),
    ),
    "invalid_input",
  )
  assert.equal(
    errorCode(
      decodeJobSpec({
        ...reviewSpec,
        idempotencyKey: "x".repeat(257),
      }),
    ),
    "invalid_input",
  )
  assert.equal(
    errorCode(
      decodeJobSpec({
        ...reviewSpec,
        recurrence: { baseMs: 60_000, jitterMs: 60_000 },
      }),
    ),
    "invalid_input",
  )
})

test("only due jobs can be claimed and a lease has bounded positive lifetime", () => {
  const scheduled = run(createJob(reviewSpec, "job-1", 1_000))
  assert.equal(scheduled.state, "scheduled")
  assert.equal(
    errorCode(claimJob(scheduled, "worker-a", "lease-a", 1_000, 90_000)),
    "invalid_transition",
  )
  assert.equal(
    errorCode(claimJob(readyJob(), "worker-a", "lease-a", 1_000, 0)),
    "invalid_input",
  )
  const claimed = leasedJob()
  assert.equal(claimed.state, "leased")
  assert.equal(claimed.attempt, 1)
})

test("a stale lease token cannot publish success or failure", () => {
  const leased = leasedJob()
  assert.equal(
    errorCode(completeJob(leased, "lease-stale", 2_000, "done")),
    "stale_lease",
  )
  assert.equal(
    errorCode(failJob(leased, "lease-stale", 2_000, 60_000, "failed")),
    "stale_lease",
  )
})

test("terminal transitions are first-writer-wins", () => {
  const completed = run(completeJob(leasedJob(), "lease-a", 2_000, "done"))
  assert.equal(completed.state, "succeeded")
  assert.equal(
    errorCode(cancelJob(completed, 3_000)),
    "invalid_transition",
  )
  assert.equal(
    errorCode(completeJob(completed, "lease-a", 3_000, "again")),
    "invalid_transition",
  )
})

test("cancellation is immediate before claim and cooperative after claim", () => {
  const cancelled = run(cancelJob(readyJob(), 2_000))
  assert.equal(cancelled.state, "cancelled")

  const requested = run(cancelJob(leasedJob(), 2_000))
  assert.equal(requested.state, "leased")
  if (requested.state !== "leased") assert.fail("expected leased job")
  assert.equal(requested.cancelRequestedAt, 2_000)
  const completed = run(completeJob(requested, "lease-a", 3_000, "stopped"))
  assert.equal(completed.state, "cancelled")
})

test("failed and abandoned attempts retry only within the persisted attempt limit", () => {
  const retrying = run(failJob(leasedJob(), "lease-a", 2_000, 60_000, "transient"))
  assert.equal(retrying.state, "retry_wait")
  assert.equal(retrying.spec.runAt, 62_000)

  const expired = run(recoverExpiredJob(leasedJob(), 100_000, 60_000))
  assert.equal(expired.state, "retry_wait")
  assert.equal(expired.spec.runAt, 160_000)

  const finalLease: Job = { ...leasedJob(), attempt: reviewSpec.maxAttempts }
  const failed = run(failJob(finalLease, "lease-a", 2_000, 60_000, "terminal"))
  assert.equal(failed.state, "failed")
})

test("an unexpired lease cannot be reclaimed", () => {
  assert.equal(
    errorCode(recoverExpiredJob(leasedJob(), 50_000, 60_000)),
    "invalid_transition",
  )
})
