import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import test from "node:test"
import { Effect, Either } from "effect"
import type { RegisteredAgent } from "../agent-registry/registry.ts"
import {
  jobResult,
  JobRuntimeError,
  type Job,
  type RegisteredJobSpec,
} from "./job-runtime.ts"
import {
  JobStoreError,
  makeSqliteJobStore,
  type SqliteJobStore,
  type StoredJob,
} from "./sqlite-job-store.ts"

const researchSpec = (profile = "research-config"): RegisteredJobSpec => ({
  kind: "harness.research",
  payload: {
    lane: "subscription-plan",
    harness: "claude-plan",
    profile,
    project: "dotconfig",
    task: "subscription-harness-adversarial-review",
    repositoryRoot: "/Users/example/.config",
    isolation: "read-only",
    ownership: { kind: "project-domain", project: "dotconfig", role: profile },
  },
  runAt: 1_000,
  maxAttempts: 3,
  recurrence: {
    baseMs: 2 * 60 * 60 * 1_000,
    jitterMs: 60 * 60 * 1_000,
  },
  idempotencyKey: `research:${profile}`,
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
  stored.flatMap(entry => (entry.outcome === "readable" ? [entry.job] : []))

const unreadableIds = (stored: readonly StoredJob[]): readonly string[] =>
  stored.flatMap(entry => (entry.outcome === "unreadable" ? [entry.id] : []))

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
  withStore(async path => {
    const store = await Effect.runPromise(makeSqliteJobStore(path))
    const first = await Effect.runPromise(
      store.enqueue(researchSpec(), "job-a", 1_000),
    )
    const duplicate = await Effect.runPromise(
      store.enqueue(researchSpec(), "job-b", 1_001),
    )
    assert.equal(first.created, true)
    assert.equal(duplicate.created, false)
    assert.equal(duplicate.job.id, first.job.id)
    assert.equal(
      await errorCode(
        store.enqueue({ ...researchSpec(), maxAttempts: 4 }, "job-c", 1_002),
      ),
      "idempotency_conflict",
    )
    store.close()
  }))

test("jobs survive closing and reopening the SQLite adapter", async () =>
  withStore(async path => {
    const first = await Effect.runPromise(makeSqliteJobStore(path))
    await Effect.runPromise(first.enqueue(researchSpec(), "job-a", 1_000))
    first.close()

    const reopened = await Effect.runPromise(makeSqliteJobStore(path))
    assert.equal((await Effect.runPromise(reopened.get("job-a"))).id, "job-a")
    reopened.close()
  }))

test("owner intervention survives closing and reopening the SQLite adapter", async () =>
  withStore(async path => {
    const first = await Effect.runPromise(makeSqliteJobStore(path))
    await Effect.runPromise(
      first.recordAgentIntervention({
        agentId: "agent-a",
        cwd: "/Users/example/code/0xgleb",
        ownerInteractionAt: 1_000,
      }),
    )
    first.close()

    const reopened = await Effect.runPromise(makeSqliteJobStore(path))
    assert.equal(
      await Effect.runPromise(reopened.agentIntervention("agent-a")),
      1_000,
    )
    reopened.close()
  }))

test("schema version six gains durable agent allocation state", async () =>
  withStore(async path => {
    const previous = new DatabaseSync(path)
    previous.exec(`
      CREATE TABLE provider_call_reservations (
        reservation_id TEXT PRIMARY KEY,
        role TEXT NOT NULL,
        provider TEXT NOT NULL,
        reserved_tokens INTEGER NOT NULL,
        actual_tokens INTEGER,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        settled_at INTEGER
      );
      CREATE TABLE provider_call_queue (
        reservation_id TEXT PRIMARY KEY,
        role TEXT NOT NULL,
        requested_tokens INTEGER NOT NULL,
        enqueued_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL
      );
      PRAGMA user_version = 6;
    `)
    previous.close()

    const store = await Effect.runPromise(makeSqliteJobStore(path))
    const queueColumns = store.unsafeDatabaseForTests
      .prepare("PRAGMA table_info(provider_call_queue)")
      .all() as ReadonlyArray<{ readonly name?: unknown }>
    assert.deepEqual(
      queueColumns.map(({ name }) => name),
      [
        "reservation_id",
        "role",
        "requested_tokens",
        "enqueued_at",
        "last_seen_at",
        "agent_id",
        "allocation_weight",
      ],
    )
    assert.ok(
      store.unsafeDatabaseForTests
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'agent_interventions'",
        )
        .get(),
    )
    store.close()
  }))

test("schema version two migrates generic allowance rows without assigning a real provider", async () =>
  withStore(async path => {
    const legacy = new DatabaseSync(path)
    legacy.exec(`
      CREATE TABLE allowance_checkpoints (
        captured_at INTEGER PRIMARY KEY,
        remaining_percent REAL NOT NULL,
        reset_at INTEGER NOT NULL
      );
      INSERT INTO allowance_checkpoints VALUES (1000, 14, 7000);
      PRAGMA user_version = 2;
    `)
    legacy.close()

    const store = await Effect.runPromise(makeSqliteJobStore(path))
    assert.deepEqual(
      await Effect.runPromise(store.listAllowanceCheckpoints(0)),
      [
        {
          provider: "legacy",
          pool: "generic",
          source: "legacy-import",
          capturedAt: 1_000,
          remainingPercent: 14,
          resetAt: 7_000,
        },
      ],
    )
    store.close()
  }))

test("schema version four migrates singleton admission to durable role rows", async () =>
  withStore(async path => {
    const legacy = new DatabaseSync(path)
    legacy.exec(`
      CREATE TABLE usage_admission (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        admitted_at INTEGER NOT NULL
      );
      INSERT INTO usage_admission VALUES (1, 1000);
      PRAGMA user_version = 4;
    `)
    legacy.close()

    const store = await Effect.runPromise(makeSqliteJobStore(path))
    const columns = store.unsafeDatabaseForTests
      .prepare("PRAGMA table_info(usage_admission)")
      .all() as ReadonlyArray<{ readonly name?: unknown }>
    assert.deepEqual(
      columns.map(({ name }) => name),
      ["role", "admitted_at"],
    )
    assert.deepEqual(
      await Effect.runPromise(
        store.claimAutonomousAdmission("general", 1_000, 0, 0),
      ),
      { allowed: true, admittedAt: 1_000 },
    )
    store.close()
  }))

test("schema version five migrates allowance samples to event rows", async () =>
  withStore(async path => {
    const previous = new DatabaseSync(path)
    previous.exec(`
      CREATE TABLE allowance_checkpoints (
        provider TEXT NOT NULL,
        pool TEXT NOT NULL,
        source TEXT NOT NULL,
        captured_at INTEGER NOT NULL,
        remaining_percent REAL NOT NULL,
        reset_at INTEGER NOT NULL,
        PRIMARY KEY (provider, pool, captured_at)
      );
      INSERT INTO allowance_checkpoints VALUES (
        'openai', 'chatgpt-shared-weekly', 'manual', 1000, 25, 7000
      );
      PRAGMA user_version = 5;
    `)
    previous.close()

    const store = await Effect.runPromise(makeSqliteJobStore(path))
    assert.deepEqual(
      await Effect.runPromise(store.listAllowanceCheckpoints(0)),
      [
        {
          provider: "openai",
          pool: "chatgpt-shared-weekly",
          source: "manual",
          capturedAt: 1_000,
          remainingPercent: 25,
          resetAt: 7_000,
        },
      ],
    )
    store.close()
  }))

test("schema version three separates app-server samples from the ChatGPT shared pool", async () =>
  withStore(async path => {
    const previous = new DatabaseSync(path)
    previous.exec(`
      CREATE TABLE allowance_checkpoints (
        provider TEXT NOT NULL,
        pool TEXT NOT NULL,
        source TEXT NOT NULL,
        captured_at INTEGER NOT NULL,
        remaining_percent REAL NOT NULL,
        reset_at INTEGER NOT NULL,
        PRIMARY KEY (provider, pool, captured_at)
      );
      INSERT INTO allowance_checkpoints VALUES (
        'openai', 'chatgpt-shared-weekly', 'codex-app-server', 1000, 100, 7000
      );
      PRAGMA user_version = 3;
    `)
    previous.close()

    const store = await Effect.runPromise(makeSqliteJobStore(path))
    assert.deepEqual(
      await Effect.runPromise(store.listAllowanceCheckpoints(0)),
      [
        {
          provider: "openai",
          pool: "codex-app-server-weekly",
          source: "codex-app-server",
          capturedAt: 1_000,
          remainingPercent: 100,
          resetAt: 7_000,
        },
      ],
    )
    store.close()
  }))

test("atomic due-job claim allows only one worker and fences stale completion", async () =>
  withStore(async path => {
    const first = await Effect.runPromise(makeSqliteJobStore(path))
    const second = await Effect.runPromise(makeSqliteJobStore(path))
    await Effect.runPromise(first.enqueue(researchSpec(), "job-a", 1_000))

    const [left, right] = await Promise.all([
      Effect.runPromise(first.claimDue("worker-a", "lease-a", 1_000, 90_000)),
      Effect.runPromise(second.claimDue("worker-b", "lease-b", 1_000, 90_000)),
    ])
    assert.equal([left, right].filter(Boolean).length, 1)
    const claimed = left ?? right
    assert.ok(claimed)
    assert.equal(claimed.state, "leased")
    if (claimed.state !== "leased") throw new Error("job was not claimed")
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
  withStore(async path => {
    const store = await Effect.runPromise(makeSqliteJobStore(path))
    await Effect.runPromise(store.enqueue(researchSpec(), "job-a", 1_000))
    await Effect.runPromise(store.claimDue("worker-a", "lease-a", 1_000, 10))
    const recovered = await Effect.runPromise(
      store.recoverExpired(1_010, 60_000),
    )
    assert.deepEqual(
      recovered.map(({ id }) => id),
      ["job-a"],
    )
    assert.equal(
      await Effect.runPromise(
        store.claimDue("worker-b", "lease-b", 61_009, 10),
      ),
      undefined,
    )
    assert.equal(
      (
        await Effect.runPromise(
          store.claimDue("worker-b", "lease-b", 61_010, 10),
        )
      )?.id,
      "job-a",
    )
    store.close()
  }))

test("a cancelled research attempt stays readable through the store", async () =>
  withStore(async path => {
    const store = await Effect.runPromise(makeSqliteJobStore(path))
    const spec = {
      ...researchSpec(),
      idempotencyKey: "research:cancelled",
      maxAttempts: 2,
    }
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

test("a research attempt whose last lease expires is stored as failed without evidence", async () =>
  withStore(async path => {
    const store = await Effect.runPromise(makeSqliteJobStore(path))
    await Effect.runPromise(
      store.enqueue(
        {
          ...researchSpec(),
          idempotencyKey: "research:expired",
          maxAttempts: 1,
        },
        "job-x",
        1_000,
      ),
    )
    await Effect.runPromise(store.claimDue("worker-a", "lease-a", 1_000, 10))
    const recovered = await Effect.runPromise(
      store.recoverExpired(1_010, 60_000),
    )
    assert.deepEqual(
      recovered.map(({ state }) => state),
      ["failed"],
    )

    const reloaded = await Effect.runPromise(store.get("job-x"))
    assert.equal(reloaded.state, "failed")
    assert.equal(jobResult(reloaded), undefined)
    store.close()
  }))

test("usage samples survive agent expiry and update within a bounded time bucket", async () =>
  withStore(async path => {
    const store = await Effect.runPromise(makeSqliteJobStore(path))
    const agent = (
      id: string,
      cwd: string,
      totalTokens: number,
    ): RegisteredAgent => ({
      identity: { id, pid: 1, model: "zai/glm-5.3" },
      cwd,
      label: id,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens,
      },
      heartbeatAt: 0,
      expiresAt: Number.MAX_SAFE_INTEGER,
    })
    await Effect.runPromise(
      store.recordUsage(
        [agent("agent-a", "/Users/example/.config", 100)],
        15 * 60 * 1_000,
      ),
    )
    await Effect.runPromise(
      store.recordUsage(
        [agent("agent-a", "/Users/example/.config", 140)],
        15 * 60 * 1_000 + 60_000,
      ),
    )
    await Effect.runPromise(
      store.recordUsage(
        [agent("agent-b", "/Users/example/code/0xgleb", 80)],
        30 * 60 * 1_000,
      ),
    )

    const samples = await Effect.runPromise(store.listUsage(0))
    assert.deepEqual(
      samples.map(({ agentId, capturedAt, usage }) => ({
        agentId,
        capturedAt,
        totalTokens: usage.totalTokens,
      })),
      [
        { agentId: "agent-a", capturedAt: 15 * 60 * 1_000, totalTokens: 140 },
        { agentId: "agent-b", capturedAt: 30 * 60 * 1_000, totalTokens: 80 },
      ],
    )
    store.close()
  }))

test("allowance checkpoints survive restarts and reject impossible resets", async () =>
  withStore(async path => {
    const first = await Effect.runPromise(makeSqliteJobStore(path))
    await Effect.runPromise(
      first.recordAllowanceCheckpoint({
        provider: "openai",
        pool: "chatgpt-shared-weekly",
        source: "manual",
        capturedAt: 1_000,
        remainingPercent: 113,
        resetAt: 7_000,
      }),
    )
    first.close()

    const reopened = await Effect.runPromise(makeSqliteJobStore(path))
    assert.deepEqual(
      await Effect.runPromise(reopened.listAllowanceCheckpoints(0)),
      [
        {
          provider: "openai",
          pool: "chatgpt-shared-weekly",
          source: "manual",
          capturedAt: 1_000,
          remainingPercent: 113,
          resetAt: 7_000,
        },
      ],
    )
    assert.equal(
      await errorCode(
        reopened.recordAllowanceCheckpoint({
          provider: "openai",
          pool: "chatgpt-shared-weekly",
          source: "manual",
          capturedAt: 8_000,
          remainingPercent: 101,
          resetAt: 7_000,
        }),
      ),
      "invalid_input",
    )
    assert.equal(
      await errorCode(
        reopened.recordAllowanceCheckpoint({
          provider: "openai",
          pool: "chatgpt-shared-weekly",
          source: "manual",
          capturedAt: 8_000,
          remainingPercent: 201,
          resetAt: 9_000,
        }),
      ),
      "invalid_input",
    )
    await Effect.runPromise(
      reopened.recordAllowanceCheckpoint({
        provider: "anthropic",
        pool: "all-models-weekly",
        source: "manual",
        capturedAt: 1_000,
        remainingPercent: 69,
        resetAt: 8_000,
      }),
    )
    assert.equal(
      (await Effect.runPromise(reopened.listAllowanceCheckpoints(0))).length,
      2,
    )
    reopened.close()
  }))

test("allowance checkpoint storage stays bounded and rejects evicted history", async () =>
  withStore(async path => {
    const store = await Effect.runPromise(makeSqliteJobStore(path))
    const insert = store.unsafeDatabaseForTests.prepare(
      `INSERT INTO allowance_checkpoints (
         provider, pool, source, captured_at, remaining_percent, event, reset_at
       ) VALUES ('openai', 'chatgpt-shared-weekly', 'manual', ?, 50, 'sample', 10000)`,
    )
    for (const capturedAt of Array.from(
      { length: 512 },
      (_value, index) => index,
    ))
      insert.run(capturedAt)

    await Effect.runPromise(
      store.recordAllowanceCheckpoint({
        provider: "openai",
        pool: "chatgpt-shared-weekly",
        source: "manual",
        capturedAt: 512,
        remainingPercent: 49,
        resetAt: 10_000,
      }),
    )
    const retained = await Effect.runPromise(store.listAllowanceCheckpoints(0))
    assert.equal(retained.length, 512)
    assert.equal(retained[0]?.capturedAt, 1)
    assert.equal(retained.at(-1)?.capturedAt, 512)

    assert.equal(
      await errorCode(
        store.recordAllowanceCheckpoint({
          provider: "openai",
          pool: "chatgpt-shared-weekly",
          source: "manual",
          capturedAt: 0,
          remainingPercent: 51,
          resetAt: 10_000,
        }),
      ),
      "capacity",
    )
    assert.equal(
      (await Effect.runPromise(store.listAllowanceCheckpoints(0))).length,
      512,
    )
    store.close()
  }))

test("autonomous admission preserves the fleet cap and a durable weighted role cap", async () =>
  withStore(async path => {
    const first = await Effect.runPromise(makeSqliteJobStore(path))
    const second = await Effect.runPromise(makeSqliteJobStore(path))
    const [left, right] = await Promise.all([
      Effect.runPromise(
        first.claimAutonomousAdmission("general", 1_000, 60_000, 300_000),
      ),
      Effect.runPromise(
        second.claimAutonomousAdmission("general", 1_000, 60_000, 300_000),
      ),
    ])
    assert.equal([left, right].filter(({ allowed }) => allowed).length, 1)
    assert.deepEqual(
      await Effect.runPromise(
        first.claimAutonomousAdmission("reviewer", 60_999, 60_000, 60_000),
      ),
      { allowed: false, retryAt: 61_000 },
    )
    assert.deepEqual(
      await Effect.runPromise(
        first.claimAutonomousAdmission("general", 61_000, 60_000, 300_000),
      ),
      { allowed: false, retryAt: 301_000 },
    )
    first.close()
    second.close()

    const reopened = await Effect.runPromise(makeSqliteJobStore(path))
    assert.deepEqual(
      await Effect.runPromise(
        reopened.claimAutonomousAdmission("general", 301_000, 60_000, 300_000),
      ),
      { allowed: true, admittedAt: 301_000 },
    )
    reopened.close()
  }))

test("provider-call reservations have durable atomic storage", async () =>
  withStore(async path => {
    const store = await Effect.runPromise(makeSqliteJobStore(path))
    const table = store.unsafeDatabaseForTests
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'provider_call_reservations'",
      )
      .get()
    assert.equal(
      typeof table === "object" &&
        table !== null &&
        "name" in table &&
        table.name,
      "provider_call_reservations",
    )
    store.close()
  }))

test("expired unresolved provider calls cannot release budget before settlement", async () =>
  withStore(async path => {
    const store = await Effect.runPromise(makeSqliteJobStore(path))
    const start = 1_000
    const windowMs = 4 * 60 * 60 * 1_000
    assert.deepEqual(
      await Effect.runPromise(
        store.reserveProviderCall({
          reservationId: "call-a",
          agentId: "agent-a",
          role: "general",
          provider: "openai",
          requestedTokens: 200_000,
          capacityTokens: 300_000,
          windowMs,
          minimumIntervalMs: 0,
          allocationWeight: 1,
          now: start,
        }),
      ),
      {
        allowed: true,
        reservationId: "call-a",
        reservedTokens: 200_000,
        expiresAt: start + 15 * 60 * 1_000,
      },
    )

    const afterReservationExpiry = start + 16 * 60 * 1_000
    const blocked = await Effect.runPromise(
      store.reserveProviderCall({
        reservationId: "call-b",
        agentId: "agent-b",
        role: "general",
        provider: "openai",
        requestedTokens: 150_000,
        capacityTokens: 300_000,
        windowMs,
        minimumIntervalMs: 0,
        allocationWeight: 1,
        now: afterReservationExpiry,
      }),
    )
    assert.equal(blocked.allowed, false)

    assert.deepEqual(
      await Effect.runPromise(
        store.settleProviderCall({
          reservationId: "call-a",
          actualTokens: 200_000,
          now: afterReservationExpiry + 1,
        }),
      ),
      {
        reservationId: "call-a",
        reservedTokens: 200_000,
        actualTokens: 200_000,
        settledAt: afterReservationExpiry + 1,
      },
    )
    store.close()
  }))

test("unresolved provider calls can reserve concurrently within the token cap", async () =>
  withStore(async path => {
    const store = await Effect.runPromise(makeSqliteJobStore(path))
    const first = await Effect.runPromise(
      store.reserveProviderCall({
        reservationId: "concurrent-a",
        agentId: "agent-a",
        role: "reviewer",
        provider: "openai",
        requestedTokens: 200_000,
        capacityTokens: 500_000,
        windowMs: 4 * 60 * 60 * 1_000,
        minimumIntervalMs: 0,
        allocationWeight: 1,
        now: 1_000,
      }),
    )
    const second = await Effect.runPromise(
      store.reserveProviderCall({
        reservationId: "concurrent-b",
        agentId: "agent-b",
        role: "general",
        provider: "openai",
        requestedTokens: 200_000,
        capacityTokens: 500_000,
        windowMs: 4 * 60 * 60 * 1_000,
        minimumIntervalMs: 0,
        allocationWeight: 1,
        now: 2_000,
      }),
    )

    assert.equal(first.allowed, true)
    assert.equal(second.allowed, true)
    store.close()
  }))

test("provider calls serialize across the fleet at the calibrated interval", async () =>
  withStore(async path => {
    const store = await Effect.runPromise(makeSqliteJobStore(path))
    const first = await Effect.runPromise(
      store.reserveProviderCall({
        reservationId: "call-a",
        agentId: "agent-a",
        role: "general",
        provider: "openai",
        requestedTokens: 100,
        capacityTokens: 1_000,
        windowMs: 60 * 60 * 1_000,
        minimumIntervalMs: 60_000,
        allocationWeight: 1,
        now: 1_000,
      }),
    )
    assert.equal(first.allowed, true)
    await Effect.runPromise(
      store.settleProviderCall({
        reservationId: "call-a",
        actualTokens: 100,
        now: 2_000,
      }),
    )

    const delayedHead = await Effect.runPromise(
      store.reserveProviderCall({
        reservationId: "call-b",
        agentId: "agent-b",
        role: "reviewer",
        provider: "openai",
        requestedTokens: 100,
        capacityTokens: 1_000,
        windowMs: 60 * 60 * 1_000,
        minimumIntervalMs: 60_000,
        allocationWeight: 1,
        now: 3_000,
      }),
    )
    assert.equal(delayedHead.allowed, false)
    if (delayedHead.allowed) return assert.fail("head must remain delayed")
    assert.ok(delayedHead.retryAt >= 61_000)
    assert.ok(delayedHead.retryAt <= 66_800)

    const delayedFollower = await Effect.runPromise(
      store.reserveProviderCall({
        reservationId: "call-c",
        agentId: "agent-c",
        role: "reviewer",
        provider: "openai",
        requestedTokens: 100,
        capacityTokens: 1_000,
        windowMs: 60 * 60 * 1_000,
        minimumIntervalMs: 60_000,
        allocationWeight: 1,
        now: 4_000,
      }),
    )
    assert.equal(delayedFollower.allowed, false)
    if (delayedFollower.allowed)
      return assert.fail("follower must remain queued")
    assert.ok(delayedFollower.retryAt >= 9_000)
    assert.ok(delayedFollower.retryAt <= 9_500)

    const stillQueued = await Effect.runPromise(
      store.reserveProviderCall({
        reservationId: "call-c",
        agentId: "agent-c",
        role: "reviewer",
        provider: "openai",
        requestedTokens: 100,
        capacityTokens: 1_000,
        windowMs: 60 * 60 * 1_000,
        minimumIntervalMs: 60_000,
        allocationWeight: 1,
        now: delayedHead.retryAt,
      }),
    )
    assert.equal(stillQueued.allowed, false)

    const released = await Effect.runPromise(
      store.reserveProviderCall({
        reservationId: "call-b",
        agentId: "agent-b",
        role: "reviewer",
        provider: "openai",
        requestedTokens: 100,
        capacityTokens: 1_000,
        windowMs: 60 * 60 * 1_000,
        minimumIntervalMs: 60_000,
        allocationWeight: 1,
        now: delayedHead.retryAt,
      }),
    )
    assert.equal(released.allowed, true)
    store.close()
  }))

test("provider queue ages work by its per-agent allocation weight", async () =>
  withStore(async path => {
    const store = await Effect.runPromise(makeSqliteJobStore(path))
    const reserve = (
      reservationId: string,
      agentId: string,
      allocationWeight: number,
      now: number,
    ) =>
      Effect.runPromise(
        store.reserveProviderCall({
          reservationId,
          agentId,
          role: "general",
          provider: "openai",
          requestedTokens: 100,
          capacityTokens: 10_000,
          windowMs: 60 * 60 * 1_000,
          minimumIntervalMs: 60_000,
          allocationWeight,
          now,
        }),
      )

    assert.equal((await reserve("blocker", "agent-a", 1, 1_000)).allowed, true)
    assert.equal(
      (await reserve("other-session", "agent-other", 1, 2_000)).allowed,
      false,
    )
    assert.equal(
      (await reserve("example-session", "agent-example", 2, 3_000)).allowed,
      false,
    )

    assert.equal(
      (await reserve("example-session", "agent-example", 2, 61_000)).allowed,
      true,
    )
    assert.equal(
      (await reserve("other-session", "agent-other", 1, 61_000)).allowed,
      false,
    )
    store.close()
  }))

test("malformed persisted allowance checkpoints fail closed", async () =>
  withStore(async path => {
    const store = await Effect.runPromise(makeSqliteJobStore(path))
    await Effect.runPromise(
      store.recordAllowanceCheckpoint({
        provider: "openai",
        pool: "chatgpt-shared-weekly",
        source: "manual",
        capturedAt: 1_000,
        remainingPercent: 25,
        resetAt: 7_000,
      }),
    )
    store.unsafeDatabaseForTests
      .prepare("UPDATE allowance_checkpoints SET remaining_percent = 201")
      .run()
    assert.equal(
      await errorCode(store.listAllowanceCheckpoints(0)),
      "corrupt_state",
    )
    store.close()
  }))

test("malformed persisted usage samples fail closed", async () =>
  withStore(async path => {
    const store = await Effect.runPromise(makeSqliteJobStore(path))
    const agent = (
      id: string,
      cwd: string,
      totalTokens: number,
    ): RegisteredAgent => ({
      identity: { id, pid: 1, model: "zai/glm-5.3" },
      cwd,
      label: id,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens,
      },
      heartbeatAt: 0,
      expiresAt: Number.MAX_SAFE_INTEGER,
    })
    await Effect.runPromise(
      store.recordUsage(
        [agent("agent-a", "/Users/example/.config", 100)],
        15 * 60 * 1_000,
      ),
    )
    store.unsafeDatabaseForTests
      .prepare("UPDATE usage_samples SET usage_total = -1")
      .run()
    assert.equal(await errorCode(store.listUsage(0)), "corrupt_state")
    store.close()
  }))

test("malformed persisted state fails closed instead of being coerced", async () =>
  withStore(async path => {
    const store = await Effect.runPromise(makeSqliteJobStore(path))
    await Effect.runPromise(store.enqueue(researchSpec(), "job-a", 1_000))
    poison(store, "job-a")
    assert.equal(await errorCode(store.get("job-a")), "corrupt_state")
    store.close()
  }))

test("an unreadable job is quarantined instead of blocking the jobs behind it", async () =>
  withStore(async path => {
    const store = await Effect.runPromise(makeSqliteJobStore(path))
    await Effect.runPromise(store.enqueue(researchSpec(), "job-a", 1_000))
    await Effect.runPromise(
      store.enqueue(
        { ...researchSpec(), idempotencyKey: "research:second" },
        "job-b",
        1_000,
      ),
    )
    poison(store, "job-a")

    const claimed = await Effect.runPromise(
      store.claimDue("worker-a", "lease-a", 1_000, 90_000),
    )
    assert.equal(claimed?.id, "job-b")
    assert.equal(stateOf(store, "job-a"), "corrupt")

    const listed = await Effect.runPromise(store.list())
    assert.deepEqual(
      readableJobs(listed).map(({ id }) => id),
      ["job-b"],
    )
    assert.deepEqual(unreadableIds(listed), ["job-a"])

    const completed = await Effect.runPromise(
      store.complete("job-b", "lease-a", 2_000, "review scan completed"),
    )
    assert.equal(completed.state, "succeeded")
    assert.equal(
      await Effect.runPromise(
        store.claimDue("worker-b", "lease-b", 3_000, 90_000),
      ),
      undefined,
    )
    store.close()
  }))

test("research claims quarantine unreadable rows and preserve other profiles and history", async () =>
  withStore(async path => {
    const store = await Effect.runPromise(makeSqliteJobStore(path))
    try {
      await Effect.runPromise(store.enqueue(researchSpec(), "job-a", 1_000))
      await Effect.runPromise(
        store.enqueue(
          { ...researchSpec(), idempotencyKey: "research:second" },
          "job-b",
          1_000,
        ),
      )
      await Effect.runPromise(
        store.enqueue(researchSpec("other-profile"), "job-other", 1_000),
      )
      await Effect.runPromise(
        store.enqueue(
          { ...researchSpec(), idempotencyKey: "research:healthy" },
          "job-z",
          1_000,
        ),
      )
      store.unsafeDatabaseForTests
        .prepare(
          "UPDATE jobs SET document = json_remove(document, '$.spec.payload.ownership') WHERE job_id IN (?, ?)",
        )
        .run("job-a", "job-b")
      const documents = store.unsafeDatabaseForTests.prepare(
        "SELECT job_id, document FROM jobs WHERE job_id IN (?, ?) ORDER BY job_id",
      )
      const originalDocuments = documents.all("job-a", "job-b")

      const claimed = await Effect.runPromise(
        store.claimDueResearch(
          "research-config",
          "worker-a",
          "lease-a",
          1_000,
          90_000,
        ),
      )
      assert.equal(claimed?.id, "job-z")
      assert.equal(stateOf(store, "job-a"), "corrupt")
      assert.equal(stateOf(store, "job-b"), "corrupt")
      assert.equal(stateOf(store, "job-other"), "ready")
      assert.deepEqual(documents.all("job-a", "job-b"), originalDocuments)
      assert.deepEqual(unreadableIds(await Effect.runPromise(store.list())), [
        "job-a",
        "job-b",
      ])
      assert.equal(
        await Effect.runPromise(
          store.claimDueResearch(
            "research-config",
            "worker-b",
            "lease-b",
            1_000,
            90_000,
          ),
        ),
        undefined,
      )
      assert.equal(
        (
          await Effect.runPromise(
            store.claimDueResearch(
              "other-profile",
              "worker-c",
              "lease-c",
              1_000,
              90_000,
            ),
          )
        )?.id,
        "job-other",
      )
    } finally {
      store.close()
    }
  }))

test("research claims commit quarantine when no readable job remains", async () =>
  withStore(async path => {
    const store = await Effect.runPromise(makeSqliteJobStore(path))
    try {
      await Effect.runPromise(store.enqueue(researchSpec(), "job-a", 1_000))
      store.unsafeDatabaseForTests
        .prepare(
          "UPDATE jobs SET document = json_remove(document, '$.spec.payload.ownership') WHERE job_id = ?",
        )
        .run("job-a")
      assert.equal(
        await Effect.runPromise(
          store.claimDueResearch(
            "research-config",
            "worker-a",
            "lease-a",
            1_000,
            90_000,
          ),
        ),
        undefined,
      )
      assert.equal(stateOf(store, "job-a"), "corrupt")
      assert.deepEqual(unreadableIds(await Effect.runPromise(store.list())), [
        "job-a",
      ])
    } finally {
      store.close()
    }
  }))

test("an unreadable expired lease is quarantined and the others still recover", async () =>
  withStore(async path => {
    const store = await Effect.runPromise(makeSqliteJobStore(path))
    await Effect.runPromise(store.enqueue(researchSpec(), "job-a", 1_000))
    await Effect.runPromise(
      store.enqueue(
        { ...researchSpec(), idempotencyKey: "research:second" },
        "job-b",
        1_000,
      ),
    )
    await Effect.runPromise(store.claimDue("worker-a", "lease-a", 1_000, 10))
    await Effect.runPromise(store.claimDue("worker-b", "lease-b", 1_000, 10))
    poison(store, "job-a")

    const recovered = await Effect.runPromise(
      store.recoverExpired(1_010, 60_000),
    )
    assert.deepEqual(
      recovered.map(({ id }) => id),
      ["job-b"],
    )
    assert.equal(stateOf(store, "job-a"), "corrupt")
    assert.equal(stateOf(store, "job-b"), "retry_wait")
    store.close()
  }))
