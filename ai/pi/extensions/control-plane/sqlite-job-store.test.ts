import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { Effect, Either } from "effect"
import {
  controlPlaneHome,
  jobResult,
  type RegisteredJobSpec,
} from "./job-runtime.ts"
import { makeSqliteJobStore } from "./sqlite-job-store.ts"

const harnessHeadSha = "a".repeat(40)

/**
 * Harness payloads are decoded against the home the control plane runs as, so
 * a fixture checkout is built under that home rather than a literal path.
 */
const registeredCheckout = (relative: string): string => {
  const home = controlPlaneHome()
  if (home === undefined)
    throw new Error("control plane home is not a canonical absolute path")
  return `${home}/${relative}`
}

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
    repositoryRoot: registeredCheckout("code/0xgleb/example"),
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

const errorCode = async <A>(effect: Effect.Effect<A, unknown>): Promise<string | undefined> => {
  const result = await Effect.runPromise(Effect.either(effect))
  if (Either.isRight(result)) return undefined
  const error = result.left
  return typeof error === "object" && error !== null && "code" in error
    ? String(error.code)
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
    const store = await Effect.runPromise(makeSqliteJobStore(path))
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
    const first = await Effect.runPromise(makeSqliteJobStore(path))
    await Effect.runPromise(first.enqueue(reviewSpec(), "job-a", 1_000))
    first.close()

    const reopened = await Effect.runPromise(makeSqliteJobStore(path))
    assert.equal((await Effect.runPromise(reopened.get("job-a"))).id, "job-a")
    reopened.close()
  }))

test("atomic due-job claim allows only one worker and fences stale completion", async () =>
  withStore(async (path) => {
    const first = await Effect.runPromise(makeSqliteJobStore(path))
    const second = await Effect.runPromise(makeSqliteJobStore(path))
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

test("expired attempts are recovered transactionally and become claimable after delay", async () =>
  withStore(async (path) => {
    const store = await Effect.runPromise(makeSqliteJobStore(path))
    await Effect.runPromise(store.enqueue(reviewSpec(), "job-a", 1_000))
    await Effect.runPromise(store.claimDue("worker-a", "lease-a", 1_000, 10))
    const recovered = await Effect.runPromise(store.recoverExpired(1_010, 60_000))
    assert.deepEqual(recovered.map(({ id }) => id), ["job-a"])
    assert.equal(await Effect.runPromise(store.claimDue("worker-b", "lease-b", 61_009, 10)), undefined)
    assert.equal(
      (await Effect.runPromise(store.claimDue("worker-b", "lease-b", 61_010, 10)))?.id,
      "job-a",
    )
    store.close()
  }))

test("a cancelled harness attempt stays readable through the store", async () =>
  withStore(async (path) => {
    const store = await Effect.runPromise(makeSqliteJobStore(path))
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
    assert.equal((await Effect.runPromise(store.list())).length, 1)
    store.close()
  }))

test("a blocked harness handoff is stored with the attempt it ended", async () =>
  withStore(async (path) => {
    const store = await Effect.runPromise(makeSqliteJobStore(path))
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
    const store = await Effect.runPromise(makeSqliteJobStore(path))
    await Effect.runPromise(
      store.enqueue(harnessSpec("harness:personal:example:9", 1), "job-x", 1_000),
    )
    await Effect.runPromise(store.claimDue("worker-a", "lease-a", 1_000, 10))
    const recovered = await Effect.runPromise(store.recoverExpired(1_010, 60_000))
    assert.deepEqual(recovered.map(({ state }) => state), ["failed"])

    const reloaded = await Effect.runPromise(store.get("job-x"))
    assert.equal(reloaded.state, "failed")
    assert.equal(jobResult(reloaded), undefined)
    store.close()
  }))

test("malformed persisted state fails closed instead of being coerced", async () =>
  withStore(async (path) => {
    const store = await Effect.runPromise(makeSqliteJobStore(path))
    await Effect.runPromise(store.enqueue(reviewSpec(), "job-a", 1_000))
    store.unsafeDatabaseForTests
      .prepare("UPDATE jobs SET document = ? WHERE job_id = ?")
      .run('{"state":"succeeded"}', "job-a")
    assert.equal(await errorCode(store.get("job-a")), "corrupt_state")
    store.close()
  }))
