import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
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

const harnessSpec = (): RegisteredJobSpec => ({
  kind: "harness.review",
  payload: {
    lane: "cursor-subscription",
    task: "review-probe",
    model: "composer-2.5",
    profile: "personal-review",
    repository: "0xgleb/example",
    pullRequest: 7,
    kind: "own",
    inputHeadSha: "a".repeat(40),
    repositoryRoot: "/Users/example/code/0xgleb/example",
    isolation: "read-only",
  },
  runAt: 2_000,
  maxAttempts: 2,
  idempotencyKey: "harness:personal:example:7",
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

test("kind-filtered claims skip due jobs of other registered kinds", async () =>
  withStore(async (path) => {
    const store = await Effect.runPromise(makeSqliteJobStore(path))
    await Effect.runPromise(store.enqueue(reviewSpec(), "job-a", 1_000))
    await Effect.runPromise(store.enqueue(harnessSpec(), "job-b", 2_000))

    const filtered = await Effect.runPromise(
      store.claimDue("worker-a", "lease-a", 3_000, 90_000, ["harness.review"]),
    )
    assert.equal(filtered?.spec.kind, "harness.review")

    const remaining = await Effect.runPromise(
      store.claimDue("worker-a", "lease-b", 3_000, 90_000, ["harness.review"]),
    )
    assert.equal(remaining, undefined)

    assert.equal(
      await errorCode(
        store.claimDue("worker-a", "lease-c", 3_000, 90_000, []),
      ),
      "invalid_input",
    )

    const unfiltered = await Effect.runPromise(
      store.claimDue("worker-a", "lease-d", 3_000, 90_000),
    )
    assert.equal(unfiltered?.spec.kind, "review-duty.scan")
    store.close()
  }))

test("idempotency-key claim filters scope workers to their own series", async () =>
  withStore(async (path) => {
    const store = await Effect.runPromise(makeSqliteJobStore(path))
    await Effect.runPromise(store.enqueue(reviewSpec(), "job-a", 1_000))
    await Effect.runPromise(
      store.enqueue(reviewSpec("dataclique-review"), "job-b", 1_000),
    )

    const missed = await Effect.runPromise(
      store.claimDue("worker-a", "lease-a", 2_000, 90_000, undefined, [
        "review-duty:personal-review",
      ]),
    )
    assert.equal(missed, undefined)

    const scoped = await Effect.runPromise(
      store.claimDue(
        "worker-a",
        "lease-b",
        2_000,
        90_000,
        ["review-duty.scan"],
        ["review-duty:dataclique-review"],
      ),
    )
    assert.equal(scoped?.id, "job-b")

    assert.equal(
      await errorCode(
        store.claimDue("worker-a", "lease-c", 2_000, 90_000, undefined, []),
      ),
      "invalid_input",
    )
    assert.equal(
      await errorCode(
        store.claimDue("worker-a", "lease-d", 2_000, 90_000, undefined, [
          "bad key with spaces",
        ]),
      ),
      "invalid_input",
    )
    store.close()
  }))

test("terminal recurring scans transactionally schedule one jittered successor", async () =>
  withStore(async (path) => {
    const store = await Effect.runPromise(makeSqliteJobStore(path))
    const spec = { ...reviewSpec(), runAt: 1_000 }
    const base = spec.recurrence?.baseMs ?? 0
    const jitter = spec.recurrence?.jitterMs ?? 0
    await Effect.runPromise(store.enqueue(spec, "job-a", 1_000))
    const claimed = await Effect.runPromise(
      store.claimDue("worker-a", "lease-a", 1_000, 90_000),
    )
    assert.equal(claimed?.id, "job-a")
    const completed = await Effect.runPromise(
      store.complete("job-a", "lease-a", 2_000, "scan complete"),
    )
    assert.equal(completed.state, "succeeded")

    const jobs = await Effect.runPromise(store.list())
    assert.equal(jobs.length, 2)
    const successor = jobs.find((job) => job.id !== "job-a")
    assert.ok(successor)
    assert.equal(successor.state, "scheduled")
    assert.equal(successor.spec.kind, "review-duty.scan")
    assert.equal(successor.spec.idempotencyKey, spec.idempotencyKey)
    assert.equal(successor.spec.runAt >= 2_000 + base - jitter, true)
    assert.equal(successor.spec.runAt <= 2_000 + base + jitter, true)

    const reseeded = await Effect.runPromise(
      store.enqueue({ ...spec, runAt: successor.spec.runAt }, "job-b", 2_500),
    )
    assert.equal(reseeded.created, false)
    assert.equal(reseeded.job.id, successor.id)
    store.close()
  }))

test("exhausted and cancelled recurring scans also reschedule while others do not", async () =>
  withStore(async (path) => {
    const store = await Effect.runPromise(makeSqliteJobStore(path))
    const spec = { ...reviewSpec(), runAt: 1_000, maxAttempts: 1 }
    await Effect.runPromise(store.enqueue(spec, "job-a", 1_000))
    await Effect.runPromise(
      store.claimDue("worker-a", "lease-a", 1_000, 90_000),
    )
    const failed = await Effect.runPromise(
      store.fail("job-a", "lease-a", 2_000, 0, "scan failed"),
    )
    assert.equal(failed.state, "failed")
    const afterFail = await Effect.runPromise(store.list())
    assert.equal(afterFail.length, 2)

    const successor = afterFail.find((job) => job.id !== "job-a")
    assert.ok(successor)
    const cancelled = await Effect.runPromise(
      store.cancel(successor.id, 3_000),
    )
    assert.equal(cancelled.state, "cancelled")
    const afterCancel = await Effect.runPromise(store.list())
    assert.equal(afterCancel.length, 3)

    await Effect.runPromise(store.enqueue(harnessSpec(), "job-h", 3_000))
    await Effect.runPromise(
      store.claimDue("worker-a", "lease-h", 3_000, 90_000, ["harness.review"]),
    )
    await Effect.runPromise(store.fail("job-h", "lease-h", 4_000, 0, "failed"))
    await Effect.runPromise(
      store.claimDue("worker-a", "lease-h2", 4_000, 90_000, ["harness.review"]),
    )
    const harnessFailed = await Effect.runPromise(
      store.fail("job-h", "lease-h2", 5_000, 0, "failed again"),
    )
    assert.equal(harnessFailed.state, "failed")
    const finalJobs = await Effect.runPromise(store.list())
    assert.equal(
      finalJobs.filter((job) => job.spec.kind === "harness.review").length,
      1,
    )
    store.close()
  }))

test("version one stores migrate to live-only idempotency uniqueness", async () =>
  withStore(async (path) => {
    const legacy = new DatabaseSync(path)
    legacy.exec(`
      CREATE TABLE jobs (
        job_id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        idempotency_key TEXT,
        state TEXT NOT NULL,
        run_at INTEGER NOT NULL,
        lease_until INTEGER,
        updated_at INTEGER NOT NULL,
        document TEXT NOT NULL,
        UNIQUE (kind, idempotency_key)
      );
      CREATE INDEX jobs_due_idx ON jobs (state, run_at, updated_at);
      PRAGMA user_version = 1;
    `)
    const legacyJob = {
      id: "job-a",
      spec: reviewSpec(),
      state: "scheduled",
      attempt: 0,
      createdAt: 500,
      updatedAt: 500,
    }
    legacy
      .prepare(
        `INSERT INTO jobs (
           job_id, kind, idempotency_key, state, run_at,
           lease_until, updated_at, document
         ) VALUES (?, ?, ?, ?, ?, NULL, ?, ?)`,
      )
      .run(
        "job-a",
        "review-duty.scan",
        "review-duty:st0x-review",
        "scheduled",
        1_000,
        500,
        JSON.stringify(legacyJob),
      )
    legacy.close()

    const store = await Effect.runPromise(makeSqliteJobStore(path))
    const migrated = await Effect.runPromise(store.get("job-a"))
    assert.equal(migrated.spec.idempotencyKey, "review-duty:st0x-review")
    await Effect.runPromise(
      store.claimDue("worker-a", "lease-a", 1_000, 90_000),
    )
    const completed = await Effect.runPromise(
      store.complete("job-a", "lease-a", 2_000, "scan complete"),
    )
    assert.equal(completed.state, "succeeded")
    assert.equal((await Effect.runPromise(store.list())).length, 2)
    store.close()
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
