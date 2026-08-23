import assert from "node:assert/strict"
import test from "node:test"
import { Effect, Either } from "effect"
import {
  toCommitSha,
  toJobId,
  type CommitSha,
  type HarnessReviewHandoff,
  type JobId,
} from "./harness-protocol.ts"
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
import { canonicalPath, type CanonicalPath } from "./review-duty-profile.ts"

const canonical = (value: string): CanonicalPath => {
  const path = canonicalPath(value)
  if (path === undefined) throw new Error(`fixture is not canonical: ${value}`)
  return path
}

const commit = (value: string): CommitSha => {
  const sha = toCommitSha(value)
  if (sha === undefined) throw new Error(`fixture is not a commit sha: ${value}`)
  return sha
}

const job = (value: string): JobId => {
  const id = toJobId(value)
  if (id === undefined)
    throw new Error(`fixture is not a job identifier: ${value}`)
  return id
}

/**
 * The home a payload is admitted against is stated by the fixture rather than
 * read from the machine, so a checkout the tests describe is registered no
 * matter which account runs them.
 */
const home = canonical("/Users/example")

const reviewSpec: RegisteredJobSpec = {
  kind: "review-duty.scan",
  payload: { profile: "st0x-review" },
  runAt: 2_000,
  maxAttempts: 3,
  recurrence: { baseMs: 2 * 60 * 60 * 1_000, jitterMs: 60 * 60 * 1_000 },
  idempotencyKey: "review-duty:st0x-review",
}

const harnessHeadSha = commit("a".repeat(40))

const harnessSpec: RegisteredJobSpec = {
  kind: "harness.review",
  payload: {
    lane: "claude-code-max",
    task: "review-loop",
    profile: "personal-review",
    repository: "0xgleb/example",
    pullRequest: 7,
    kind: "own",
    inputHeadSha: harnessHeadSha,
    repositoryRoot: canonical(`${home}/code/0xgleb/example`),
    isolation: "read-only",
  },
  runAt: 2_000,
  maxAttempts: 2,
  idempotencyKey: "harness:personal:example:7:head",
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
  run(createJob({ ...reviewSpec, runAt: 1_000 }, "job-1", 1_000, home))

const leasedJob = (): Job =>
  run(claimJob(readyJob(), "worker-a", "lease-a", 1_000, 90_000))

test("the untrusted enqueue boundary accepts only registered bounded job payloads", () => {
  assert.deepEqual(REGISTERED_JOB_KINDS, [
    "review-duty.scan",
    "harness.review",
    "harness.research",
  ])
  assert.deepEqual(run(decodeJobSpec(reviewSpec, home)), reviewSpec)
  assert.deepEqual(run(decodeJobSpec(harnessSpec, home)), harnessSpec)
  assert.equal(
    errorCode(
      decodeJobSpec(
        {
          ...reviewSpec,
          kind: "shell.run",
          payload: { command: "arbitrary command" },
        },
        home,
      ),
    ),
    "invalid_input",
  )
  assert.equal(
    errorCode(
      decodeJobSpec({ ...reviewSpec, payload: { profile: "unknown-review" } }, home),
    ),
    "invalid_input",
  )
  assert.equal(
    errorCode(
      decodeJobSpec({ ...reviewSpec, idempotencyKey: "x".repeat(257) }, home),
    ),
    "invalid_input",
  )
  assert.equal(
    errorCode(
      decodeJobSpec(
        { ...reviewSpec, recurrence: { baseMs: 60_000, jitterMs: 60_000 } },
        home,
      ),
    ),
    "invalid_input",
  )
})

test("a harness payload is admitted only for a checkout registered under the stated home", () => {
  const elsewhere = canonical("/Users/other")
  assert.equal(
    errorCode(decodeJobSpec(harnessSpec, elsewhere)),
    "invalid_input",
  )
  assert.deepEqual(run(decodeJobSpec(harnessSpec, home)), harnessSpec)
})

test("a stored harness job stays readable when the home it was admitted under moves", () => {
  const stored = run(createJob({ ...harnessSpec, runAt: 1_000 }, "job-h", 1_000, home))
  assert.deepEqual(run(decodeStoredJob(stored)), stored)
  assert.equal(
    errorCode(decodeJobSpec(stored.spec, canonical("/Users/other"))),
    "invalid_input",
  )

  const malformed = {
    ...stored,
    spec: {
      ...stored.spec,
      payload: { ...harnessSpec.payload, repositoryRoot: "relative/checkout" },
    },
  }
  assert.equal(errorCode(decodeStoredJob(malformed)), "invalid_input")
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
    { ...succeeded, result: { kind: "harness.review", handoff: matchingHandoff } },
    { ...failed, result: { kind: "harness.review", handoff: matchingHandoff } },
  ]

  for (const stored of malformed)
    assert.equal(errorCode(decodeStoredJob(stored)), "invalid_input")
  assert.deepEqual(
    run(decodeStoredJob(cancelledBeforeClaim)),
    cancelledBeforeClaim,
  )
})

test("only due jobs can be claimed and a lease has bounded positive lifetime", () => {
  const scheduled = run(createJob(reviewSpec, "job-1", 1_000, home))
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
  const retrying = run(failJob(leasedJob(), "lease-a", 2_000, 60_000, "transient"))
  if (retrying.state !== "retry_wait") assert.fail("expected a retrying job")
  assert.equal(retrying.spec.runAt, 62_000)
  assert.equal(retrying.lastAttemptSummary, "transient")
  assert.deepEqual(run(decodeStoredJob(retrying)), retrying)

  const expired = run(recoverExpiredJob(leasedJob(), 100_000, 60_000))
  if (expired.state !== "retry_wait") assert.fail("expected a retrying job")
  assert.equal(expired.spec.runAt, 160_000)
  assert.equal(expired.lastAttemptSummary, "worker lease expired")

  const finalLease: Job = { ...leasedJob(), attempt: reviewSpec.maxAttempts }
  const failed = run(failJob(finalLease, "lease-a", 2_000, 60_000, "terminal"))
  assert.equal(failed.state, "failed")
})

const leasedHarnessJob = (): Job =>
  run(
    claimJob(
      run(createJob({ ...harnessSpec, runAt: 1_000 }, "job-h", 1_000, home)),
      "worker-a",
      "lease-a",
      1_000,
      90_000,
    ),
  )

const matchingHandoff = {
  protocolVersion: 1,
  jobId: job("job-h"),
  attempt: 1,
  lane: "claude-code-max",
  repository: "0xgleb/example",
  pullRequest: 7,
  inputHeadSha: harnessHeadSha,
  outputHeadSha: harnessHeadSha,
  status: "clean",
  assessment: "No verified findings.",
  evidence: ["check:review-core"],
  verifier: "fable-clean",
  executorProvenance: "subscription-verified",
} as const

const blockedHandoff = (attempt: number): HarnessReviewHandoff => ({
  ...matchingHandoff,
  attempt,
  status: "blocked",
  assessment: "Fable verification is unavailable.",
  evidence: [],
  verifier: "unavailable",
})

const finalHarnessAttempt = (): Job => ({
  ...leasedHarnessJob(),
  attempt: harnessSpec.maxAttempts,
})

test("completeJob accepts only a matching successful typed harness result", () => {
  assert.equal(
    errorCode(completeJob(leasedHarnessJob(), "lease-a", 2_000, "done")),
    "invalid_input",
  )
  assert.equal(
    errorCode(
      completeJob(leasedHarnessJob(), "lease-a", 2_000, "done", {
        kind: "harness.review",
        handoff: { ...matchingHandoff, inputHeadSha: "b".repeat(40) },
      }),
    ),
    "invalid_input",
  )
  assert.equal(
    errorCode(
      completeJob(leasedHarnessJob(), "lease-a", 2_000, "done", {
        kind: "harness.review",
        handoff: {
          ...matchingHandoff,
          status: "blocked",
          verifier: "unavailable",
          evidence: [],
        },
      }),
    ),
    "invalid_transition",
  )
  const completed = run(
    completeJob(leasedHarnessJob(), "lease-a", 2_000, "done", {
      kind: "harness.review",
      handoff: matchingHandoff,
    }),
  )
  assert.equal(completed.state, "succeeded")
  assert.deepEqual(jobResult(completed), {
    kind: "harness.review",
    handoff: matchingHandoff,
  })
})

test("completeJob decodes the handoff it is handed instead of trusting it", () => {
  assert.equal(
    errorCode(
      completeJob(leasedHarnessJob(), "lease-a", 2_000, "done", {
        kind: "harness.review",
        handoff: { ...matchingHandoff, evidence: ["arbitrary reviewer note"] },
      }),
    ),
    "invalid_input",
  )
  assert.equal(
    errorCode(
      completeJob(leasedHarnessJob(), "lease-a", 2_000, "done", {
        kind: "harness.review",
        handoff: { ...matchingHandoff, assessment: "   " },
      }),
    ),
    "invalid_input",
  )
})

test("an unsuccessful harness handoff fails the job and keeps its evidence", () => {
  const handoff = blockedHandoff(harnessSpec.maxAttempts)
  const failed = run(
    failJob(
      finalHarnessAttempt(),
      "lease-a",
      2_000,
      0,
      "harness blocked: Fable verification is unavailable.",
      { kind: "harness.review", handoff },
    ),
  )
  assert.equal(failed.state, "failed")
  assert.deepEqual(jobResult(failed), { kind: "harness.review", handoff })
  assert.deepEqual(run(decodeStoredJob(failed)), failed)
})

test("a retried harness attempt keeps why it stopped without carrying its evidence", () => {
  const retrying = run(
    failJob(
      leasedHarnessJob(),
      "lease-a",
      2_000,
      60_000,
      "harness blocked: Fable verification is unavailable.",
      { kind: "harness.review", handoff: blockedHandoff(1) },
    ),
  )
  if (retrying.state !== "retry_wait") assert.fail("expected a retrying job")
  assert.equal(jobResult(retrying), undefined)
  assert.equal(
    retrying.lastAttemptSummary,
    "harness blocked: Fable verification is unavailable.",
  )
  assert.deepEqual(run(decodeStoredJob(retrying)), retrying)
  assert.equal(
    errorCode(
      decodeStoredJob({ ...retrying, lastAttemptSummary: undefined }),
    ),
    "invalid_input",
  )
})

test("failJob accepts only an unsuccessful handoff bound to the attempt", () => {
  assert.equal(
    errorCode(
      failJob(finalHarnessAttempt(), "lease-a", 2_000, 0, "done", {
        kind: "harness.review",
        handoff: { ...matchingHandoff, attempt: harnessSpec.maxAttempts },
      }),
    ),
    "invalid_transition",
  )
  assert.equal(
    errorCode(
      failJob(finalHarnessAttempt(), "lease-a", 2_000, 0, "blocked", {
        kind: "harness.review",
        handoff: blockedHandoff(1),
      }),
    ),
    "invalid_input",
  )
  assert.equal(
    errorCode(
      failJob(leasedJob(), "lease-a", 2_000, 0, "blocked", {
        kind: "harness.review",
        handoff: blockedHandoff(1),
      }),
    ),
    "invalid_input",
  )
})

test("cancelled harness attempts without results survive the stored-job roundtrip", () => {
  const cancelRequested = run(cancelJob(leasedHarnessJob(), 2_000))
  const failedAfterCancel = run(
    failJob(cancelRequested, "lease-a", 3_000, 0, "executor blocked"),
  )
  assert.equal(failedAfterCancel.state, "cancelled")
  assert.deepEqual(run(decodeStoredJob(failedAfterCancel)), failedAfterCancel)

  const expiredAfterCancel = run(
    recoverExpiredJob(cancelRequested, 100_000, 60_000),
  )
  assert.equal(expiredAfterCancel.state, "cancelled")
  assert.deepEqual(run(decodeStoredJob(expiredAfterCancel)), expiredAfterCancel)
})

test("a harness attempt abandoned on its last try fails carrying no evidence", () => {
  const abandoned = run(
    recoverExpiredJob(finalHarnessAttempt(), 100_000, 60_000),
  )
  assert.equal(abandoned.state, "failed")
  if (abandoned.state !== "failed") assert.fail("expected a failed job")
  assert.equal(jobResult(abandoned), undefined)
  assert.equal(abandoned.summary, "worker lease expired")
  assert.deepEqual(run(decodeStoredJob(abandoned)), abandoned)
})

test("stored harness results are revalidated with the same rules as completion", () => {
  const succeeded = run(
    completeJob(leasedHarnessJob(), "lease-a", 2_000, "done", {
      kind: "harness.review",
      handoff: matchingHandoff,
    }),
  )
  assert.deepEqual(run(decodeStoredJob(succeeded)), succeeded)
  assert.equal(
    errorCode(decodeStoredJob({ ...succeeded, result: undefined })),
    "invalid_input",
  )
  assert.equal(
    errorCode(
      decodeStoredJob({
        ...succeeded,
        result: {
          kind: "harness.review",
          handoff: {
            ...matchingHandoff,
            status: "blocked",
            verifier: "unavailable",
            evidence: [],
          },
        },
      }),
    ),
    "invalid_input",
  )
  assert.equal(
    errorCode(
      decodeStoredJob({
        ...succeeded,
        result: { kind: "harness.review", handoff: { forged: true } },
      }),
    ),
    "invalid_input",
  )

  const handoff = blockedHandoff(harnessSpec.maxAttempts)
  const failed = run(
    failJob(finalHarnessAttempt(), "lease-a", 2_000, 0, "harness blocked", {
      kind: "harness.review",
      handoff,
    }),
  )
  assert.equal(
    errorCode(
      decodeStoredJob({
        ...failed,
        result: {
          kind: "harness.review",
          handoff: { ...matchingHandoff, attempt: harnessSpec.maxAttempts },
        },
      }),
    ),
    "invalid_input",
  )
})

test("a cancelled harness attempt keeps the handoff that raced the cancellation", () => {
  const cancelRequested = run(cancelJob(leasedHarnessJob(), 2_000))
  const cancelled = run(
    completeJob(cancelRequested, "lease-a", 3_000, "done", {
      kind: "harness.review",
      handoff: matchingHandoff,
    }),
  )
  assert.equal(cancelled.state, "cancelled")
  assert.deepEqual(jobResult(cancelled), {
    kind: "harness.review",
    handoff: matchingHandoff,
  })
  assert.deepEqual(run(decodeStoredJob(cancelled)), cancelled)
})

test("an unexpired lease cannot be reclaimed", () => {
  assert.equal(
    errorCode(recoverExpiredJob(leasedJob(), 50_000, 60_000)),
    "invalid_transition",
  )
})
