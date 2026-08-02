import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { Effect, Either } from "effect"
import type { RegisteredJobSpec } from "./job-runtime.ts"
import { makeSqliteJobStore } from "./sqlite-job-store.ts"

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
    assert.equal(duplicate.id, first.id)
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
