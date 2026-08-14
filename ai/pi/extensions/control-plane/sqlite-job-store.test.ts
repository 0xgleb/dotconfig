import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { Effect, Either } from "effect"
import { toCommitSha, type CommitSha } from "./harness-protocol.ts"
import {
  jobResult,
  JobRuntimeError,
  type Job,
  type RegisteredJobSpec,
} from "./job-runtime.ts"
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

const commit = (value: string): CommitSha => {
  const sha = toCommitSha(value)
  if (sha === undefined) throw new Error(`fixture is not a commit sha: ${value}`)
  return sha
}

const harnessHeadSha = commit("a".repeat(40))

const recoveryRetryDelays = {
  "harness.review": 60_000,
  "review-duty.scan": 0,
} as const

/**
 * The home a payload is admitted against is stated by the fixture rather than
 * read from the machine, so a checkout the tests describe is registered no
 * matter which account runs them.
 */
const home = canonical("/Users/example")

const harnessSpec = (
  idempotencyKey: string,
  maxAttempts: number,
): RegisteredJobSpec => ({
  kind: "harness.review",
  payload: {
    lane: "cursor-subscription",
    task: "review-probe",
    model: "composer-2.5",
    profile: "personal-review",
    repository: "0xgleb/example",
    pullRequest: 7,
    kind: "own",
    inputHeadSha: harnessHeadSha,
    repositoryRoot: canonical(`${home}/code/0xgleb/example`),
    isolation: "read-only",
  },
  runAt: 1_000,
  maxAttempts,
  idempotencyKey,
})

const reviewSpec = (
  profile: "st0x-review" | "dataclique-review" | "personal-review" =
    "st0x-review",
): RegisteredJobSpec => ({
  kind: "review-duty.scan",
  payload: { profile },
  runAt: 1_000,
  maxAttempts: 3,
  recurrence: {
    baseMs: 2 * 60 * 60 * 1_000,
    jitterMs: 60 * 60 * 1_000,
  },
  idempotencyKey: `review-duty:${profile}`,
})

/**
 * The code of the typed failure an effect produced. The parameter names the
 * two error types the store is allowed to fail with, so an effect whose
 * channel widened past them is rejected here rather than reported by a
 * matching code string.
 */
const errorCode = async <A>(
  effect: Effect.Effect<A, JobStoreError | JobRuntimeError>,
): Promise<JobStoreError["code"] | JobRuntimeError["code"]> => {
  const result = await Effect.runPromise(Effect.either(effect))
  if (Either.isRight(result)) assert.fail("expected a typed store failure")
  const failure = result.left
  assert.ok(
    failure._tag === "JobStoreError" || failure._tag === "JobRuntimeError",
    "expected a store or runtime failure",
  )
  return failure.code
}

const readableJobs = (stored: readonly StoredJob[]): readonly Job[] =>
  stored.flatMap((entry) => (entry.outcome === "readable" ? [entry.job] : []))

const unreadableIds = (stored: readonly StoredJob[]): readonly string[] =>
  stored.flatMap((entry) => (entry.outcome === "unreadable" ? [entry.id] : []))

/** Replaces a stored document with one the runtime can no longer decode. */
const poison = (store: SqliteJobStore, id: string): void => {
  store.unsafeDatabaseForTests
    .prepare("UPDATE jobs SET document = ? WHERE job_id = ?")
    .run('{"state":"succeeded"}', id)
}

const stateOf = (store: SqliteJobStore, id: string): unknown => {
  const row = store.unsafeDatabaseForTests
    .prepare("SELECT state FROM jobs WHERE job_id = ?")
    .get(id)
  return typeof row === "object" && row !== null && "state" in row
    ? row.state
    : undefined
}

const withStore = async (
  run: (path: string) => Promise<void>,
): Promise<void> => {
  const root = await mkdtemp(join(tmpdir(), "pi-control-plane-test-"))
  try {
    await run(join(root, "jobs.sqlite"))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

test("idempotent enqueue returns the persisted job and rejects payload drift", async () =>
  withStore(async (path) => {
    const store = await Effect.runPromise(makeSqliteJobStore(path, home))
    const first = await Effect.runPromise(
      store.enqueue(reviewSpec(), "job-a", 1_000),
    )
    const duplicate = await Effect.runPromise(
      store.enqueue(reviewSpec(), "job-b", 1_001),
    )
    assert.equal(first.created, true)
    assert.equal(duplicate.created, false)
    assert.equal(duplicate.job.id, first.job.id)
    assert.equal(
      await errorCode(
        store.enqueue(
          { ...reviewSpec(), maxAttempts: 4 },
          "job-c",
          1_002,
        ),
      ),
      "idempotency_conflict",
    )
    store.close()
  }))

test("jobs survive closing and reopening the SQLite adapter", async () =>
  withStore(async (path) => {
    const first = await Effect.runPromise(makeSqliteJobStore(path, home))
    await Effect.runPromise(first.enqueue(reviewSpec(), "job-a", 1_000))
    first.close()

    const reopened = await Effect.runPromise(makeSqliteJobStore(path, home))
    assert.equal((await Effect.runPromise(reopened.get("job-a"))).id, "job-a")
    reopened.close()
  }))

test("atomic due-job claim allows only one worker and fences stale completion", async () =>
  withStore(async (path) => {
    const first = await Effect.runPromise(makeSqliteJobStore(path, home))
    const second = await Effect.runPromise(makeSqliteJobStore(path, home))
    await Effect.runPromise(first.enqueue(reviewSpec(), "job-a", 1_000))

    const [left, right] = await Promise.all([
      Effect.runPromise(first.claimDue("worker-a", "lease-a", 1_000, 90_000)),
      Effect.runPromise(second.claimDue("worker-b", "lease-b", 1_000, 90_000)),
    ])
    assert.equal([left, right].filter(Boolean).length, 1)
    const claimed = left ?? right
    assert.ok(claimed)
    const currentStore = claimed.leaseToken === "lease-a" ? first : second
    assert.equal(
      await errorCode(
        currentStore.complete(claimed.id, "lease-stale", 2_000, "done"),
      ),
      "stale_lease",
    )
    const completed = await Effect.runPromise(
      currentStore.complete(claimed.id, claimed.leaseToken, 2_000, "done"),
    )
    assert.equal(completed.state, "succeeded")
    first.close()
    second.close()
  }))

test("expired attempts are recovered with their job-kind retry delay", async () =>
  withStore(async (path) => {
    const store = await Effect.runPromise(makeSqliteJobStore(path, home))
    await Effect.runPromise(store.enqueue(reviewSpec(), "job-a", 1_000))
    await Effect.runPromise(store.claimDue("worker-a", "lease-a", 1_000, 10))
    const recovered = await Effect.runPromise(
      store.recoverExpired(1_010, recoveryRetryDelays),
    )
    assert.deepEqual(recovered.map(({ id }) => id), ["job-a"])
    assert.equal(await Effect.runPromise(store.claimDue("worker-b", "lease-b", 1_009, 10)), undefined)
    assert.equal(
      (await Effect.runPromise(store.claimDue("worker-b", "lease-b", 1_010, 10)))?.id,
      "job-a",
    )
    store.close()
  }))

test("a cancelled harness attempt stays readable through the store", async () =>
  withStore(async (path) => {
    const store = await Effect.runPromise(makeSqliteJobStore(path, home))
    const spec = harnessSpec("harness:personal:example:7", 2)
    await Effect.runPromise(store.enqueue(spec, "job-h", 1_000))
    await Effect.runPromise(
      store.claimDue("worker-a", "lease-a", 1_000, 90_000),
    )
    await Effect.runPromise(store.cancel("job-h", 2_000))
    const cancelled = await Effect.runPromise(
      store.fail("job-h", "lease-a", 3_000, 0, "executor blocked"),
    )
    assert.equal(cancelled.state, "cancelled")

    const reloaded = await Effect.runPromise(store.get("job-h"))
    assert.equal(reloaded.state, "cancelled")
    assert.deepEqual(
      readableJobs(await Effect.runPromise(store.list())).map(({ id }) => id),
      ["job-h"],
    )
    store.close()
  }))

test("a blocked harness handoff is stored with the attempt it ended", async () =>
  withStore(async (path) => {
    const store = await Effect.runPromise(makeSqliteJobStore(path, home))
    await Effect.runPromise(
      store.enqueue(harnessSpec("harness:personal:example:8", 1), "job-b", 1_000),
    )
    const claimed = await Effect.runPromise(
      store.claimDue("worker-a", "lease-a", 1_000, 90_000),
    )
    assert.equal(claimed?.attempt, 1)

    const handoff = {
      protocolVersion: 1,
      jobId: "job-b",
      attempt: 1,
      lane: "cursor-subscription",
      repository: "0xgleb/example",
      pullRequest: 7,
      inputHeadSha: harnessHeadSha,
      outputHeadSha: harnessHeadSha,
      status: "blocked",
      assessment: "Fable verification is unavailable.",
      evidence: [],
      verifier: "unavailable",
      executorProvenance: "subscription-verified",
    } as const
    const failed = await Effect.runPromise(
      store.fail("job-b", "lease-a", 2_000, 0, "harness blocked", {
        kind: "harness.review",
        handoff,
      }),
    )
    assert.equal(failed.state, "failed")

    const reloaded = await Effect.runPromise(store.get("job-b"))
    assert.equal(reloaded.state, "failed")
    assert.deepEqual(jobResult(reloaded), { kind: "harness.review", handoff })
    store.close()
  }))

test("a harness attempt whose last lease expires is stored as failed without evidence", async () =>
  withStore(async (path) => {
    const store = await Effect.runPromise(makeSqliteJobStore(path, home))
    await Effect.runPromise(
      store.enqueue(harnessSpec("harness:personal:example:9", 1), "job-x", 1_000),
    )
    await Effect.runPromise(store.claimDue("worker-a", "lease-a", 1_000, 10))
    const recovered = await Effect.runPromise(
      store.recoverExpired(1_010, recoveryRetryDelays),
    )
    assert.deepEqual(recovered.map(({ state }) => state), ["failed"])

    const reloaded = await Effect.runPromise(store.get("job-x"))
    assert.equal(reloaded.state, "failed")
    assert.equal(jobResult(reloaded), undefined)
    store.close()
  }))

test("malformed persisted state fails closed instead of being coerced", async () =>
  withStore(async (path) => {
    const store = await Effect.runPromise(makeSqliteJobStore(path, home))
    await Effect.runPromise(store.enqueue(reviewSpec(), "job-a", 1_000))
    poison(store, "job-a")
    assert.equal(await errorCode(store.get("job-a")), "corrupt_state")
    store.close()
  }))

test("an unreadable job is quarantined instead of blocking the jobs behind it", async () =>
  withStore(async (path) => {
    const store = await Effect.runPromise(makeSqliteJobStore(path, home))
    await Effect.runPromise(store.enqueue(reviewSpec(), "job-a", 1_000))
    await Effect.runPromise(
      store.enqueue(reviewSpec("dataclique-review"), "job-b", 1_000),
    )
    poison(store, "job-a")

    const claimed = await Effect.runPromise(
      store.claimDue("worker-a", "lease-a", 1_000, 90_000),
    )
    assert.equal(claimed?.id, "job-b")
    assert.equal(stateOf(store, "job-a"), "corrupt")

    const listed = await Effect.runPromise(store.list())
    assert.deepEqual(readableJobs(listed).map(({ id }) => id), ["job-b"])
    assert.deepEqual(unreadableIds(listed), ["job-a"])

    const completed = await Effect.runPromise(
      store.complete("job-b", "lease-a", 2_000, "review scan completed"),
    )
    assert.equal(completed.state, "succeeded")
    assert.equal(
      await Effect.runPromise(store.claimDue("worker-b", "lease-b", 3_000, 90_000)),
      undefined,
    )
    store.close()
  }))

test("an unreadable expired lease is quarantined and the others still recover", async () =>
  withStore(async (path) => {
    const store = await Effect.runPromise(makeSqliteJobStore(path, home))
    await Effect.runPromise(store.enqueue(reviewSpec(), "job-a", 1_000))
    await Effect.runPromise(
      store.enqueue(reviewSpec("dataclique-review"), "job-b", 1_000),
    )
    await Effect.runPromise(store.claimDue("worker-a", "lease-a", 1_000, 10))
    await Effect.runPromise(store.claimDue("worker-b", "lease-b", 1_000, 10))
    poison(store, "job-a")

    const recovered = await Effect.runPromise(
      store.recoverExpired(1_010, recoveryRetryDelays),
    )
    assert.deepEqual(recovered.map(({ id }) => id), ["job-b"])
    assert.equal(stateOf(store, "job-a"), "corrupt")
    assert.equal(stateOf(store, "job-b"), "retry_wait")
    store.close()
  }))
