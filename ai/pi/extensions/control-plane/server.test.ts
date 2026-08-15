import assert from "node:assert/strict"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { Effect, Either } from "effect"
import { toJobId, type JobId } from "./harness-protocol.ts"
import { JobRuntimeError, type Job } from "./job-runtime.ts"
import {
  boundedReason,
  MAX_LOGGED_REASON_CHARS,
  startControlPlaneServer,
  type ControlPlaneJobStore,
} from "./server.ts"
import { canonicalPath, type CanonicalPath } from "./review-duty-profile.ts"
import {
  JobStoreError,
  makeSqliteJobStore,
  type SqliteJobStore,
  type StoredJob,
} from "./sqlite-job-store.ts"

const canonical = (value: string): CanonicalPath => {
  const path = canonicalPath(value)
  if (path === undefined) throw new Error(`fixture is not canonical: ${value}`)
  return path
}

const jobIdentifier = (value: string): JobId => {
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

const registeredCheckout = (relative: string): string => `${home}/${relative}`

/**
 * A store that implements only the operations a test exercises. Every other
 * operation dies rather than being faked, so a route that starts touching one
 * fails the test that did not expect it instead of reading a stub's answer.
 */
const partialStore = (
  operations: Partial<ControlPlaneJobStore>,
): ControlPlaneJobStore => ({
  enqueue: unavailable("enqueue"),
  get: unavailable("get"),
  list: unavailable("list"),
  claimDue: unavailable("claimDue"),
  complete: unavailable("complete"),
  fail: unavailable("fail"),
  recoverExpired: unavailable("recoverExpired"),
  ...operations,
})

const unavailable =
  (operation: string) =>
  (): Effect.Effect<never> =>
    Effect.die(new Error(`the test store does not implement ${operation}`))

/**
 * A store that judges leases against a clock the test moves. The server samples
 * one instant per request and hands it to the store, so shifting that instant
 * here expires a lease deterministically instead of racing a real timer.
 */
const aheadOfTime = (
  store: SqliteJobStore,
  elapsedMs: () => number,
): ControlPlaneJobStore => {
  const shifted = (
    instant: number | Effect.Effect<number>,
  ): number | Effect.Effect<number> =>
    typeof instant === "number"
      ? instant + elapsedMs()
      : Effect.map(instant, (now) => now + elapsedMs())
  return {
    ...store,
    claimDue: (workerId, leaseToken, now, ttlMs, kind) =>
      store.claimDue(workerId, leaseToken, now + elapsedMs(), ttlMs, kind),
    complete: (id, leaseToken, now, summary, result) =>
      store.complete(id, leaseToken, shifted(now), summary, result),
    fail: (id, leaseToken, now, retryDelayMs, summary, result) =>
      store.fail(
        id,
        leaseToken,
        shifted(now),
        retryDelayMs,
        summary,
        result,
      ),
    recoverExpired: (now, retryDelays) =>
      store.recoverExpired(now + elapsedMs(), retryDelays),
  }
}

const readableJobs = (stored: readonly StoredJob[]): readonly Job[] =>
  stored.flatMap((entry) => (entry.outcome === "readable" ? [entry.job] : []))

const withServer = async (
  run: (origin: string, store: SqliteJobStore) => Promise<void>,
): Promise<void> => {
  const root = await mkdtemp(join(tmpdir(), "pi-control-plane-http-test-"))
  const store = await Effect.runPromise(
    makeSqliteJobStore(join(root, "jobs.sqlite"), home),
  )
  const server = await Effect.runPromise(
    startControlPlaneServer({ host: "127.0.0.1", port: 0, store, home }),
  )
  try {
    await run(server.origin, store)
  } finally {
    await Effect.runPromise(server.close)
    store.close()
    await rm(root, { recursive: true, force: true })
  }
}

const enqueueBody = {
  kind: "review-duty.scan",
  payload: { profile: "st0x-review" },
  runAt: 1_000,
  maxAttempts: 3,
  recurrence: {
    baseMs: 2 * 60 * 60 * 1_000,
    jitterMs: 60 * 60 * 1_000,
  },
  idempotencyKey: "review-duty:st0x-review",
}

const harnessHeadSha = "a".repeat(40)
const harnessEnqueueBody = {
  kind: "harness.review",
  payload: {
    lane: "cursor-subscription",
    task: "review-probe",
    model: "grok-4.5",
    profile: "personal-review",
    repository: "0xgleb/example",
    pullRequest: 7,
    kind: "own",
    inputHeadSha: harnessHeadSha,
    repositoryRoot: registeredCheckout("code/0xgleb/example"),
    isolation: "read-only",
  },
  runAt: 0,
  maxAttempts: 2,
  idempotencyKey: "harness:personal:example:7:head",
}

const harnessHandoff = (
  jobId: string,
  attempt: number,
  overrides: Readonly<Record<string, unknown>> = {},
): Readonly<Record<string, unknown>> => ({
  protocolVersion: 1,
  jobId,
  attempt,
  lane: "cursor-subscription",
  repository: "0xgleb/example",
  pullRequest: 7,
  inputHeadSha: harnessHeadSha,
  outputHeadSha: harnessHeadSha,
  status: "clean",
  assessment: "No verified findings.",
  evidence: ["check:review-core"],
  verifier: "fable-clean",
  executorProvenance: "subscription-verified",
  ...overrides,
})

const claimJob = async (
  origin: string,
  workerId: string,
  kind: "harness.review" | "review-duty.scan" = "harness.review",
): Promise<{ id: string; leaseToken: string; attempt: number }> => {
  const claimed = await fetch(`${origin}/v1/worker/claim`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ workerId, ttlMs: 90_000, kind }),
  })
  return ((await claimed.json()) as {
    job: { id: string; leaseToken: string; attempt: number }
  }).job
}

const failJob = async (
  origin: string,
  id: string,
  body: unknown,
): Promise<Response> =>
  fetch(`${origin}/v1/jobs/${id}/fail`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })

const enqueueJob = async (origin: string, body: unknown): Promise<string> => {
  const enqueued = await fetch(`${origin}/v1/jobs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
  return ((await enqueued.json()) as { job: { id: string } }).job.id
}

test("the server refuses non-loopback bind addresses", async () => {
  const result = await Effect.runPromise(
    Effect.either(
      startControlPlaneServer({
        host: "0.0.0.0",
        port: 0,
        store: partialStore({}),
        home,
      }),
    ),
  )
  assert.ok(Either.isLeft(result))
  if (Either.isRight(result)) assert.fail("expected bind rejection")
  assert.equal(result.left.code, "invalid_bind")
})

test("health and read-only job routes return bounded versioned JSON", async () =>
  withServer(async (origin) => {
    const health = await fetch(`${origin}/v1/health`)
    assert.equal(health.status, 200)
    assert.deepEqual(await health.json(), {
      status: "ok",
      protocolVersion: 1,
      schemaVersion: 1,
    })

    const jobs = await fetch(`${origin}/v1/jobs`)
    assert.equal(jobs.status, 200)
    assert.deepEqual(await jobs.json(), { jobs: [], unreadable: [] })
  }))

test("registered enqueue is idempotent and unknown executable kinds fail closed", async () =>
  withServer(async (origin) => {
    const enqueue = async (body: unknown): Promise<Response> =>
      fetch(`${origin}/v1/jobs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      })

    const first = await enqueue(enqueueBody)
    assert.equal(first.status, 201)
    const firstJob = (await first.json()) as { job: { id: string } }

    const duplicate = await enqueue(enqueueBody)
    assert.equal(duplicate.status, 200)
    const duplicateJob = (await duplicate.json()) as { job: { id: string } }
    assert.equal(duplicateJob.job.id, firstJob.job.id)

    const rejected = await enqueue({
      ...enqueueBody,
      kind: "shell.run",
      payload: { command: "arbitrary command" },
    })
    assert.equal(rejected.status, 400)
    assert.deepEqual(await rejected.json(), {
      error: { code: "invalid_input", message: "job request is invalid" },
    })
  }))

test("concurrent idempotent enqueue reports exactly one creation", async () => {
  const job: Job = {
    id: jobIdentifier("job-a"),
    spec: {
      kind: "review-duty.scan",
      payload: { profile: "st0x-review" },
      runAt: 1_000,
      maxAttempts: 3,
      recurrence: { baseMs: 2 * 60 * 60 * 1_000, jitterMs: 60 * 60 * 1_000 },
      idempotencyKey: "review-duty:st0x-review",
    },
    state: "ready",
    attempt: 0,
    createdAt: 1_000,
    updatedAt: 1_000,
  }
  let enqueueCount = 0
  let listCount = 0
  let releaseLists: (() => void) | undefined
  const listsReleased = new Promise<void>((resolve) => {
    releaseLists = resolve
  })
  const store = partialStore({
    list: () =>
      Effect.promise(async () => {
        listCount += 1
        if (listCount === 2) releaseLists?.()
        await listsReleased
        return []
      }),
    enqueue: () =>
      Effect.sync(() => {
        const created = enqueueCount === 0
        enqueueCount += 1
        return { job, created }
      }),
  })
  const server = await Effect.runPromise(
    startControlPlaneServer({ host: "127.0.0.1", port: 0, store, home }),
  )
  try {
    const enqueue = () =>
      fetch(`${server.origin}/v1/jobs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(enqueueBody),
      })
    const responses = await Promise.all([enqueue(), enqueue()])
    assert.deepEqual(
      responses.map(({ status }) => status).sort(),
      [200, 201],
    )
    const jobs = await Promise.all(
      responses.map(
        (response) => response.json() as Promise<{ job: { id: string } }>,
      ),
    )
    assert.equal(jobs[0]?.job.id, jobs[1]?.job.id)
    assert.equal(listCount, 0, "enqueue status must not depend on a list snapshot")
  } finally {
    await Effect.runPromise(server.close)
  }
})

test("workers claim due jobs with server-issued leases and stale completion is fenced", async () =>
  withServer(async (origin) => {
    const due = { ...enqueueBody, runAt: Date.now() - 1_000 }
    const enqueued = await fetch(`${origin}/v1/jobs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(due),
    })
    const created = (await enqueued.json()) as { job: { id: string } }

    const claim = await fetch(`${origin}/v1/worker/claim`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        workerId: "reviewer-a",
        ttlMs: 90_000,
        kind: "review-duty.scan",
      }),
    })
    assert.equal(claim.status, 200)
    const claimed = (await claim.json()) as {
      job: { id: string; leaseToken: string; state: string }
    }
    assert.equal(claimed.job.id, created.job.id)
    assert.equal(claimed.job.state, "leased")
    assert.match(claimed.job.leaseToken, /^[0-9a-f-]{36}$/)

    const noSecondJob = await fetch(`${origin}/v1/worker/claim`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        workerId: "reviewer-b",
        ttlMs: 90_000,
        kind: "review-duty.scan",
      }),
    })
    assert.equal(noSecondJob.status, 204)

    const stale = await fetch(`${origin}/v1/jobs/${created.job.id}/complete`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ leaseToken: "stale-token", summary: "done" }),
    })
    assert.equal(stale.status, 409)
    assert.deepEqual(await stale.json(), {
      error: { code: "stale_lease", message: "job lease is stale" },
    })

    const complete = await fetch(`${origin}/v1/jobs/${created.job.id}/complete`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        leaseToken: claimed.job.leaseToken,
        summary: "review scan completed",
      }),
    })
    assert.equal(complete.status, 200)
    assert.equal(((await complete.json()) as { job: { state: string } }).job.state, "succeeded")
  }))

test("worker claims select only their requested registered job kind", async () =>
  withServer(async (origin) => {
    const reviewId = await enqueueJob(origin, { ...enqueueBody, runAt: 0 })
    const harnessId = await enqueueJob(origin, harnessEnqueueBody)

    const harness = await claimJob(origin, "harness-supervisor")
    assert.equal(harness.id, harnessId)
    const review = await claimJob(
      origin,
      "review-duty-worker",
      "review-duty.scan",
    )
    assert.equal(review.id, reviewId)
  }))

test("harness jobs accept only a matching bounded typed handoff", async () =>
  withServer(async (origin) => {
    const id = await enqueueJob(origin, harnessEnqueueBody)
    const claimed = await claimJob(origin, "harness-supervisor")
    const endpoint = `${origin}/v1/jobs/${id}/complete`
    const complete = async (body: unknown): Promise<Response> =>
      fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      })

    const legacySummary = await complete({
      leaseToken: claimed.leaseToken,
      summary: "untyped",
    })
    assert.equal(legacySummary.status, 400)
    assert.deepEqual(await legacySummary.json(), {
      error: { code: "invalid_input", message: "request payload is invalid" },
    })

    const undecodable = await complete({
      leaseToken: claimed.leaseToken,
      handoff: harnessHandoff(id, claimed.attempt, { protocolVersion: 2 }),
    })
    assert.equal(undecodable.status, 400)
    assert.deepEqual(await undecodable.json(), {
      error: { code: "invalid_input", message: "request payload is invalid" },
    })

    const mismatched = await complete({
      leaseToken: claimed.leaseToken,
      handoff: harnessHandoff(id, claimed.attempt, {
        inputHeadSha: "b".repeat(40),
      }),
    })
    assert.equal(mismatched.status, 400)
    assert.deepEqual(await mismatched.json(), {
      error: { code: "invalid_input", message: "job request is invalid" },
    })

    const staleLease = await complete({
      leaseToken: "stale-token",
      handoff: harnessHandoff(id, claimed.attempt),
    })
    assert.equal(staleLease.status, 409)
    assert.deepEqual(await staleLease.json(), {
      error: { code: "stale_lease", message: "job lease is stale" },
    })

    const succeeded = await complete({
      leaseToken: claimed.leaseToken,
      handoff: harnessHandoff(id, claimed.attempt),
    })
    assert.equal(succeeded.status, 200)
    const completed = (await succeeded.json()) as {
      job: {
        state: string
        result?: { kind: string; handoff: { jobId: string } }
      }
    }
    assert.equal(completed.job.state, "succeeded")
    assert.equal(completed.job.result?.kind, "harness.review")
    assert.equal(completed.job.result?.handoff.jobId, id)

    const persisted = await fetch(`${origin}/v1/jobs`)
    assert.equal(persisted.status, 200)
    const persistedJobs = (await persisted.json()) as {
      jobs: Array<{ result?: { handoff: { jobId: string } } }>
    }
    assert.equal(persistedJobs.jobs[0]?.result?.handoff.jobId, id)
  }))

test("the harness completion envelope accepts exactly a lease token and a handoff", async () =>
  withServer(async (origin) => {
    const id = await enqueueJob(origin, harnessEnqueueBody)
    const claimed = await claimJob(origin, "harness-supervisor")
    const complete = async (body: unknown): Promise<Response> =>
      fetch(`${origin}/v1/jobs/${id}/complete`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      })

    const extraField = await complete({
      leaseToken: claimed.leaseToken,
      handoff: harnessHandoff(id, claimed.attempt),
      urgent: true,
    })
    assert.equal(extraField.status, 400)
    assert.deepEqual(await extraField.json(), {
      error: { code: "invalid_input", message: "request payload is invalid" },
    })

    const withoutHandoff = await complete({ leaseToken: claimed.leaseToken })
    assert.equal(withoutHandoff.status, 400)
    assert.deepEqual(await withoutHandoff.json(), {
      error: { code: "invalid_input", message: "request payload is invalid" },
    })
  }))

test("a blocked harness attempt with retries left answers with the retrying job", async () =>
  withServer(async (origin) => {
    const id = await enqueueJob(origin, harnessEnqueueBody)
    const claimed = await claimJob(origin, "harness-supervisor")

    const blocked = await fetch(`${origin}/v1/jobs/${id}/complete`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        leaseToken: claimed.leaseToken,
        handoff: harnessHandoff(id, claimed.attempt, {
          status: "blocked",
          assessment: "Fable verification is unavailable.",
          evidence: [],
          verifier: "unavailable",
        }),
      }),
    })
    assert.equal(blocked.status, 200)
    const retrying = (await blocked.json()) as {
      job: { state: string; lastAttemptSummary?: string }
    }
    assert.equal(retrying.job.state, "retry_wait")
    assert.equal(
      retrying.job.lastAttemptSummary,
      "harness blocked: Fable verification is unavailable.",
    )

    const persisted = (await (await fetch(`${origin}/v1/jobs`)).json()) as {
      jobs: Array<{ state: string; lastAttemptSummary?: string }>
    }
    assert.equal(persisted.jobs[0]?.state, "retry_wait")
    assert.equal(
      persisted.jobs[0]?.lastAttemptSummary,
      "harness blocked: Fable verification is unavailable.",
    )
  }))

test("a blocked harness handoff ends the attempt and keeps its evidence", async () =>
  withServer(async (origin) => {
    const id = await enqueueJob(origin, {
      ...harnessEnqueueBody,
      maxAttempts: 1,
    })
    const claimed = await claimJob(origin, "harness-supervisor")

    const blocked = await fetch(`${origin}/v1/jobs/${id}/complete`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        leaseToken: claimed.leaseToken,
        handoff: harnessHandoff(id, claimed.attempt, {
          status: "blocked",
          assessment: "Fable verification is unavailable.",
          evidence: [],
          verifier: "unavailable",
        }),
      }),
    })
    assert.equal(blocked.status, 200)
    const failed = (await blocked.json()) as {
      job: { state: string; result?: { handoff: { status: string } } }
    }
    assert.equal(failed.job.state, "failed")
    assert.equal(failed.job.result?.handoff.status, "blocked")

    const persisted = (await (await fetch(`${origin}/v1/jobs`)).json()) as {
      jobs: Array<{ state: string; result?: { handoff: { status: string } } }>
    }
    assert.equal(persisted.jobs[0]?.state, "failed")
    assert.equal(persisted.jobs[0]?.result?.handoff.status, "blocked")
  }))

test("completing a job that does not exist reports it as missing", async () =>
  withServer(async (origin) => {
    const missing = await fetch(`${origin}/v1/jobs/absent-job/complete`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ leaseToken: "lease-a", summary: "done" }),
    })
    assert.equal(missing.status, 404)
    assert.deepEqual(await missing.json(), {
      error: { code: "not_found", message: "job was not found" },
    })
  }))

test("failed attempts retry through the fail route until attempts are exhausted", async () =>
  withServer(async (origin) => {
    const id = await enqueueJob(origin, harnessEnqueueBody)
    const first = await claimJob(origin, "harness-supervisor")

    const unknownFields = await failJob(origin, id, {
      leaseToken: first.leaseToken,
      retryDelayMs: 0,
      summary: "executor failed",
      command: "rm -rf /",
    })
    assert.equal(unknownFields.status, 400)

    const stale = await failJob(origin, id, {
      leaseToken: "not-the-lease",
      retryDelayMs: 0,
      summary: "executor failed",
    })
    assert.equal(stale.status, 409)

    const retried = await failJob(origin, id, {
      leaseToken: first.leaseToken,
      retryDelayMs: 0,
      summary: "executor failed",
    })
    assert.equal(retried.status, 200)
    const retriedJob = (await retried.json()) as { job: { state: string } }
    assert.equal(retriedJob.job.state, "retry_wait")

    // The retrying job is waiting out the harness backoff, so the attempt that
    // exhausts a budget is reported on a job whose only attempt this is.
    const lastId = await enqueueJob(origin, {
      ...harnessEnqueueBody,
      maxAttempts: 1,
      idempotencyKey: "harness:personal:example:7:last",
    })
    const last = await claimJob(origin, "harness-supervisor")
    assert.equal(last.id, lastId)
    const exhausted = await failJob(origin, lastId, {
      leaseToken: last.leaseToken,
      retryDelayMs: 0,
      summary: "executor failed again",
    })
    assert.equal(exhausted.status, 200)
    const exhaustedJob = (await exhausted.json()) as { job: { state: string } }
    assert.equal(exhaustedJob.job.state, "failed")
  }))

test("the fail route backs a harness attempt off by the harness delay, not the caller's", async () =>
  withServer(async (origin) => {
    const harnessId = await enqueueJob(origin, harnessEnqueueBody)
    const scanId = await enqueueJob(origin, {
      ...enqueueBody,
      runAt: 1_000,
    })

    const harnessClaim = await claimJob(origin, "harness-supervisor")
    assert.equal(harnessClaim.id, harnessId)
    const reportedAt = Date.now()
    const harnessFailure = await failJob(origin, harnessId, {
      leaseToken: harnessClaim.leaseToken,
      retryDelayMs: 0,
      summary: "executor exited with code 1",
    })
    assert.equal(harnessFailure.status, 200)
    const backedOff = (await harnessFailure.json()) as {
      job: { state: string; spec: { runAt: number } }
    }
    assert.equal(backedOff.job.state, "retry_wait")
    assert.equal(backedOff.job.spec.runAt >= reportedAt + 5 * 60 * 1_000, true)

    const scanClaim = await claimJob(
      origin,
      "review-duty-worker",
      "review-duty.scan",
    )
    assert.equal(scanClaim.id, scanId)
    const scanFailure = await failJob(origin, scanId, {
      leaseToken: scanClaim.leaseToken,
      retryDelayMs: 0,
      summary: "scan failed",
    })
    assert.equal(scanFailure.status, 200)
    const rescheduled = (await scanFailure.json()) as {
      job: { state: string; spec: { runAt: number } }
    }
    assert.equal(rescheduled.job.state, "retry_wait")
    assert.equal(rescheduled.job.spec.runAt < reportedAt + 5 * 60 * 1_000, true)
  }))

test("a recovered harness lease waits the harness backoff before it is due again", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-control-plane-lease-test-"))
  const store = await Effect.runPromise(
    makeSqliteJobStore(join(root, "jobs.sqlite"), home),
  )
  let elapsedMs = 0
  const server = await Effect.runPromise(
    startControlPlaneServer({
      host: "127.0.0.1",
      port: 0,
      store: aheadOfTime(store, () => elapsedMs),
      home,
    }),
  )
  const claim = async (workerId: string): Promise<Response> =>
    fetch(`${server.origin}/v1/worker/claim`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workerId, ttlMs: 90_000, kind: "harness.review" }),
    })
  try {
    const id = await enqueueJob(server.origin, harnessEnqueueBody)
    const first = await fetch(`${server.origin}/v1/worker/claim`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        workerId: "worker-a",
        ttlMs: 1,
        kind: "harness.review",
      }),
    })
    assert.equal(first.status, 200)
    const firstJob = (await first.json()) as {
      job: { leaseToken: string; attempt: number }
    }

    // The lease has expired, so this claim recovers the attempt — but an
    // abandoned harness attempt waits the same backoff a reported one does.
    elapsedMs = 60_000
    assert.equal((await claim("worker-b")).status, 204)

    elapsedMs = 60_000 + 5 * 60 * 1_000
    const reclaimed = await claim("worker-b")
    assert.equal(reclaimed.status, 200)
    const job = (await reclaimed.json()) as {
      job: { id: string; attempt: number }
    }
    assert.equal(job.job.id, id)
    assert.equal(job.job.attempt, 2)

    const stale = await fetch(`${server.origin}/v1/jobs/${id}/complete`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        leaseToken: firstJob.job.leaseToken,
        handoff: harnessHandoff(id, job.job.attempt),
      }),
    })
    assert.equal(stale.status, 409)
    assert.deepEqual(await stale.json(), {
      error: { code: "stale_lease", message: "job lease is stale" },
    })
    const persisted = await fetch(`${server.origin}/v1/jobs`)
    const jobs = (await persisted.json()) as {
      jobs: Array<{ id: string; state: string; attempt: number }>
    }
    const recoveredJob = jobs.jobs.find(({ id: jobId }) => jobId === id)
    assert.equal(recoveredJob?.state, "leased")
    assert.equal(recoveredJob?.attempt, 2)
  } finally {
    await Effect.runPromise(server.close)
    store.close()
    await rm(root, { recursive: true, force: true })
  }
})

test("lease recovery receives a retry delay for each registered job kind", async () => {
  let observed: Readonly<Record<string, number>> | undefined
  const store = partialStore({
    recoverExpired: (_now, retryDelays) =>
      Effect.sync(() => {
        observed = retryDelays
        return []
      }),
    claimDue: () => Effect.succeed(undefined),
  })
  const server = await Effect.runPromise(
    startControlPlaneServer({ host: "127.0.0.1", port: 0, store, home }),
  )
  try {
    const claimed = await fetch(`${server.origin}/v1/worker/claim`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        workerId: "worker-a",
        ttlMs: 90_000,
        kind: "review-duty.scan",
      }),
    })
    assert.equal(claimed.status, 204)
    assert.deepEqual(observed, {
      "harness.review": 5 * 60 * 1_000,
      "review-duty.scan": 0,
    })
  } finally {
    await Effect.runPromise(server.close)
  }
})

test("a claim whose lease recovery fails on a tolerated store code still reads the queue", async () => {
  let claims = 0
  const store = partialStore({
    recoverExpired: () =>
      Effect.fail(
        new JobStoreError({ code: "corrupt_state", message: "recovery failed" }),
      ),
    claimDue: () =>
      Effect.sync(() => {
        claims += 1
        return undefined
      }),
  })
  const server = await Effect.runPromise(
    startControlPlaneServer({ host: "127.0.0.1", port: 0, store, home }),
  )
  try {
    const claimed = await fetch(`${server.origin}/v1/worker/claim`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        workerId: "worker-a",
        ttlMs: 90_000,
        kind: "review-duty.scan",
      }),
    })
    assert.equal(claimed.status, 204)
    assert.equal(claims, 1)
  } finally {
    await Effect.runPromise(server.close)
  }
})

test("a recovery that breaks a runtime invariant fails the claim instead of being swallowed", async () => {
  const store = partialStore({
    recoverExpired: () =>
      Effect.fail(
        new JobRuntimeError({
          code: "invalid_input",
          message: "now cannot precede the current job state",
        }),
      ),
  })
  const server = await Effect.runPromise(
    startControlPlaneServer({ host: "127.0.0.1", port: 0, store, home }),
  )
  try {
    const claimed = await fetch(`${server.origin}/v1/worker/claim`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        workerId: "worker-a",
        ttlMs: 90_000,
        kind: "review-duty.scan",
      }),
    })
    assert.equal(claimed.status, 400)
  } finally {
    await Effect.runPromise(server.close)
  }
})

test("a swallowed failure reaches the log as one bounded line", () => {
  assert.equal(boundedReason("first\nsecond\nthird"), "first second third")
  assert.equal(
    boundedReason("x".repeat(MAX_LOGGED_REASON_CHARS + 50)),
    "x".repeat(MAX_LOGGED_REASON_CHARS),
  )
  assert.equal(
    boundedReason(`${"y".repeat(MAX_LOGGED_REASON_CHARS)}\nleaked`).includes(
      "leaked",
    ),
    false,
  )
})

test("the fail and completion routes time their transition inside the store", async () => {
  const leased: Job = {
    id: jobIdentifier("job-a"),
    spec: {
      kind: "review-duty.scan",
      payload: { profile: "st0x-review" },
      runAt: 0,
      maxAttempts: 3,
      idempotencyKey: "review-duty:st0x-review",
    },
    state: "leased",
    workerId: "worker-a",
    leaseToken: "lease-a",
    leaseUntil: 90_000,
    attempt: 1,
    createdAt: 0,
    updatedAt: 0,
  }
  const transitioned: Job = {
    id: leased.id,
    spec: leased.spec,
    state: "retry_wait",
    attempt: 1,
    createdAt: 0,
    updatedAt: 0,
    lastAttemptSummary: "worker reported a failure",
  }
  const sampled: Record<string, { started: number; instant: number }> = {}
  const transition =
    (route: string) =>
    (
      _id: string,
      _leaseToken: string,
      now: number | Effect.Effect<number>,
    ): Effect.Effect<Job> =>
      Effect.gen(function* () {
        const started = Date.now()
        yield* Effect.sleep("25 millis")
        const instant = typeof now === "number" ? now : yield* now
        sampled[route] = { started, instant }
        return transitioned
      })
  const store = partialStore({
    get: () => Effect.succeed(leased),
    fail: transition("fail"),
    complete: transition("complete"),
  })
  const server = await Effect.runPromise(
    startControlPlaneServer({ host: "127.0.0.1", port: 0, store, home }),
  )
  try {
    const failed = await failJob(server.origin, "job-a", {
      leaseToken: "lease-a",
      retryDelayMs: 0,
      summary: "worker reported a failure",
    })
    assert.equal(failed.status, 200)

    const completed = await fetch(`${server.origin}/v1/jobs/job-a/complete`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ leaseToken: "lease-a", summary: "done" }),
    })
    assert.equal(completed.status, 200)
  } finally {
    await Effect.runPromise(server.close)
  }
  for (const route of ["fail", "complete"]) {
    const record = sampled[route]
    assert.ok(record, `${route} never reached the store`)
    assert.equal(record.instant >= record.started, true)
  }
})

test("worker boundaries reject unknown fields and client-supplied lease tokens", async () =>
  withServer(async (origin) => {
    const rejected = await fetch(`${origin}/v1/worker/claim`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        workerId: "reviewer-a",
        ttlMs: 90_000,
        kind: "review-duty.scan",
        leaseToken: "caller-chosen",
      }),
    })
    assert.equal(rejected.status, 400)
    assert.deepEqual(await rejected.json(), {
      error: { code: "invalid_input", message: "request payload is invalid" },
    })
  }))

test("oversized and malformed request bodies are rejected without enqueueing", async () =>
  withServer(async (origin, store) => {
    const oversized = await fetch(`${origin}/v1/jobs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...enqueueBody, padding: "x".repeat(20_000) }),
    })
    assert.equal(oversized.status, 413)

    const malformed = await fetch(`${origin}/v1/jobs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not-json",
    })
    assert.equal(malformed.status, 400)
    assert.deepEqual(readableJobs(await Effect.runPromise(store.list())), [])
  }))

test("unknown routes and unsupported methods do not fall through", async () =>
  withServer(async (origin) => {
    assert.equal((await fetch(`${origin}/v1/unknown`)).status, 404)
    assert.equal(
      (
        await fetch(`${origin}/v1/jobs`, {
          method: "DELETE",
        })
      ).status,
      405,
    )
  }))

test("the loopback server exposes only the three reviewed dashboard assets", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-control-plane-dashboard-test-"))
  const dashboardDirectory = join(root, "dashboard")
  await mkdir(dashboardDirectory)
  await Promise.all([
    writeFile(join(dashboardDirectory, "index.html"), "<!doctype html><title>Control plane</title>"),
    writeFile(join(dashboardDirectory, "app.js"), "console.log('dashboard')"),
    writeFile(join(dashboardDirectory, "app.css"), "body{background:#07111f}"),
  ])
  const store = await Effect.runPromise(
    makeSqliteJobStore(join(root, "jobs.sqlite"), home),
  )
  const server = await Effect.runPromise(
    startControlPlaneServer({
      host: "127.0.0.1",
      port: 0,
      store,
      home,
      dashboardDirectory,
    }),
  )
  try {
    const index = await fetch(`${server.origin}/`)
    assert.equal(index.status, 200)
    assert.match(index.headers.get("content-type") ?? "", /text\/html/)
    assert.match(index.headers.get("content-security-policy") ?? "", /default-src 'self'/)
    assert.match(await index.text(), /Control plane/)

    assert.match(
      (await fetch(`${server.origin}/app.js`)).headers.get("content-type") ?? "",
      /javascript/,
    )
    assert.match(
      (await fetch(`${server.origin}/app.css`)).headers.get("content-type") ?? "",
      /text\/css/,
    )
    assert.equal((await fetch(`${server.origin}/not-an-asset`)).status, 404)
    assert.equal((await fetch(`${server.origin}/app.js`, { method: "POST" })).status, 405)
  } finally {
    await Effect.runPromise(server.close)
    store.close()
    await rm(root, { recursive: true, force: true })
  }
})
