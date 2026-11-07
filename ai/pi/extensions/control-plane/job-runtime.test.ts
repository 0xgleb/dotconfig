import assert from "node:assert/strict"
import test from "node:test"
import { Effect, Either } from "effect"
import {
  cancelJob,
  claimJob,
  completeJob,
  createJob,
  decodeJobSpec,
  decodeStoredJob,
  failJob,
  jobResult,
  JobRuntimeError,
  recoverExpiredJob,
  REGISTERED_JOB_KINDS,
  type Job,
  type RegisteredJobSpec,
} from "./job-runtime.ts"

const researchSpec: RegisteredJobSpec = {
  kind: "harness.research",
  payload: {
    lane: "subscription-plan",
    harness: "claude-plan",
    profile: "research-config",
    project: "dotconfig",
    task: "subscription-harness-adversarial-review",
    repositoryRoot: "/Users/example/.config",
    isolation: "read-only",
    ownership: {
      kind: "project-domain",
      project: "dotconfig",
      role: "research-config",
    },
  },
  runAt: 2_000,
  maxAttempts: 3,
  recurrence: { baseMs: 2 * 60 * 60 * 1_000, jitterMs: 60 * 60 * 1_000 },
  idempotencyKey: "research:dotconfig:1",
}

const run = <A>(effect: Effect.Effect<A, JobRuntimeError>): A =>
  Effect.runSync(effect)

/**
 * The code of the runtime failure an effect produced. The parameter is the
 * runtime's own error type, so an effect whose channel widened past it — a
 * protocol failure that stopped being translated, say — is rejected here
 * instead of passing on a matching code string.
 */
const errorCode = <A>(
  effect: Effect.Effect<A, JobRuntimeError>,
): JobRuntimeError["code"] => {
  const result = Effect.runSync(Effect.either(effect))
  if (Either.isRight(result)) assert.fail("expected a JobRuntimeError failure")
  assert.equal(result.left._tag, "JobRuntimeError")
  return result.left.code
}

const readyJob = (): Job =>
  run(createJob({ ...researchSpec, runAt: 1_000 }, "job-1", 1_000))

const leasedJob = (): Job =>
  run(claimJob(readyJob(), "worker-a", "lease-a", 1_000, 90_000))

test("research handoff survives completion and persisted round trip", () => {
  const spec: RegisteredJobSpec = {
    kind: "harness.research",
    payload: {
      lane: "subscription-plan",
      harness: "claude-plan",
      profile: "research-config",
      project: "dotconfig",
      task: "subscription-harness-adversarial-review",
      repositoryRoot: "/Users/example/.config",
      isolation: "read-only",
      ownership: {
        kind: "project-domain",
        project: "dotconfig",
        role: "research-config",
      },
    },
    runAt: 1_000,
    maxAttempts: 2,
  }
  const created = run(createJob(spec, "research-1", 1_000))
  const leased = run(claimJob(created, "worker-a", "lease-a", 1_000, 90_000))
  const handoff = {
    protocolVersion: 1 as const,
    jobId: "research-1",
    attempt: 1,
    lane: "subscription-plan" as const,
    profile: "research-config",
    task: "subscription-harness-adversarial-review",
    status: "completed" as const,
    summary: "Verified the bounded research task",
    evidence: ["source.ts: ownership boundary verified"],
  }
  const result = { kind: "harness.research" as const, handoff }
  const completed = run(
    completeJob(leased, "lease-a", 1_001, handoff.summary, result),
  )
  assert.equal(completed.state, "succeeded")
  assert.deepEqual(jobResult(completed), result)
  assert.deepEqual(run(decodeStoredJob(completed)), completed)

  for (const invalidHandoff of [
    { ...handoff, jobId: "another-job" },
    { ...handoff, attempt: 2 },
    { ...handoff, summary: "   " },
    { ...handoff, evidence: ["unsafe\u0000content"] },
  ]) {
    const invalidResult = { ...result, handoff: invalidHandoff }
    assert.equal(
      errorCode(
        completeJob(leased, "lease-a", 1_001, handoff.summary, invalidResult),
      ),
      "invalid_input",
    )
    assert.equal(
      errorCode(decodeStoredJob({ ...completed, result: invalidResult })),
      "invalid_input",
    )
  }

  const cancelRequested = run(cancelJob(leased, 1_001))
  const cancelled = run(
    completeJob(cancelRequested, "lease-a", 1_002, handoff.summary, result),
  )
  assert.equal(cancelled.state, "cancelled")
  assert.deepEqual(jobResult(cancelled), result)
  assert.deepEqual(run(decodeStoredJob(cancelled)), cancelled)
})

test("the untrusted enqueue boundary accepts only registered bounded job payloads", () => {
  assert.deepEqual(REGISTERED_JOB_KINDS, ["harness.research"])
  assert.deepEqual(run(decodeJobSpec(researchSpec)), researchSpec)
  assert.equal(
    errorCode(
      decodeJobSpec({
        ...researchSpec,
        kind: "shell.run",
        payload: { command: "arbitrary command" },
      }),
    ),
    "invalid_input",
  )
  assert.equal(
    errorCode(
      decodeJobSpec({
        ...researchSpec,
        payload: { ...researchSpec.payload, ownership: undefined },
      }),
    ),
    "invalid_input",
  )
  assert.equal(
    errorCode(
      decodeJobSpec({ ...researchSpec, idempotencyKey: "x".repeat(257) }),
    ),
    "invalid_input",
  )
  assert.equal(
    errorCode(
      decodeJobSpec({
        ...researchSpec,
        recurrence: { baseMs: 60_000, jitterMs: 60_000 },
      }),
    ),
    "invalid_input",
  )
})

test("persisted jobs reject impossible state-specific combinations", () => {
  const ready = readyJob()
  const leased = leasedJob()
  const succeeded = run(completeJob(leased, "lease-a", 2_000, "done"))
  const failed = run(
    failJob(
      { ...leased, attempt: leased.spec.maxAttempts },
      "lease-a",
      2_000,
      0,
      "failed",
    ),
  )
  const cancelledBeforeClaim = run(cancelJob(ready, 2_000))

  const malformed = [
    { ...ready, state: "scheduled", attempt: 1 },
    {
      ...ready,
      state: "scheduled",
      spec: { ...ready.spec, runAt: ready.updatedAt },
    },
    {
      ...ready,
      state: "ready",
      spec: { ...ready.spec, runAt: ready.updatedAt + 1 },
    },
    { ...ready, state: "retry_wait", attempt: 0 },
    {
      ...ready,
      state: "retry_wait",
      attempt: 1,
      spec: { ...ready.spec, runAt: ready.updatedAt - 1 },
    },
    { ...leased, leaseUntil: leased.createdAt },
    { ...succeeded, attempt: 0 },
    { ...succeeded, summary: undefined },
    { ...succeeded, finishedAt: succeeded.updatedAt + 1 },
    { ...failed, attempt: failed.spec.maxAttempts - 1 },
    { ...cancelledBeforeClaim, attempt: 1 },
    {
      ...succeeded,
      result: { kind: "harness.research", handoff: {} },
    },
    { ...failed, result: { kind: "harness.research", handoff: {} } },
  ]

  for (const stored of malformed)
    assert.equal(errorCode(decodeStoredJob(stored)), "invalid_input")
  assert.deepEqual(
    run(decodeStoredJob(cancelledBeforeClaim)),
    cancelledBeforeClaim,
  )
})

test("only due jobs can be claimed and a lease has bounded positive lifetime", () => {
  const scheduled = run(createJob(researchSpec, "job-1", 1_000))
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

test("a stale or expired lease cannot publish success or failure", () => {
  const leased = leasedJob()
  assert.equal(
    errorCode(completeJob(leased, "lease-stale", 2_000, "done")),
    "stale_lease",
  )
  assert.equal(
    errorCode(failJob(leased, "lease-stale", 2_000, 60_000, "failed")),
    "stale_lease",
  )
  assert.equal(
    errorCode(completeJob(leased, "lease-a", leased.leaseUntil, "late")),
    "stale_lease",
  )
})

test("state transitions reject backwards external timestamps", () => {
  const leased = leasedJob()
  assert.equal(
    errorCode(completeJob(leased, "lease-a", leased.updatedAt - 1, "done")),
    "invalid_input",
  )
  assert.equal(
    errorCode(cancelJob(readyJob(), readyJob().updatedAt - 1)),
    "invalid_input",
  )
})

test("terminal transitions are first-writer-wins", () => {
  const completed = run(completeJob(leasedJob(), "lease-a", 2_000, "done"))
  assert.equal(completed.state, "succeeded")
  assert.equal(errorCode(cancelJob(completed, 3_000)), "invalid_transition")
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
  assert.deepEqual(run(cancelJob(requested, 3_000)), requested)
  const completed = run(completeJob(requested, "lease-a", 3_000, "stopped"))
  assert.equal(completed.state, "cancelled")
})

test("failed and abandoned attempts retry only within the persisted attempt limit", () => {
  const retrying = run(
    failJob(leasedJob(), "lease-a", 2_000, 60_000, "transient"),
  )
  if (retrying.state !== "retry_wait") assert.fail("expected a retrying job")
  assert.equal(retrying.spec.runAt, 62_000)
  assert.equal(retrying.lastAttemptSummary, "transient")
  assert.deepEqual(run(decodeStoredJob(retrying)), retrying)

  const expired = run(recoverExpiredJob(leasedJob(), 100_000, 60_000))
  if (expired.state !== "retry_wait") assert.fail("expected a retrying job")
  assert.equal(expired.spec.runAt, 160_000)
  assert.equal(expired.lastAttemptSummary, "worker lease expired")

  const finalLease: Job = { ...leasedJob(), attempt: researchSpec.maxAttempts }
  const failed = run(failJob(finalLease, "lease-a", 2_000, 60_000, "terminal"))
  assert.equal(failed.state, "failed")
})

test("an unexpired lease cannot be reclaimed", () => {
  assert.equal(
    errorCode(recoverExpiredJob(leasedJob(), 50_000, 60_000)),
    "invalid_transition",
  )
})
