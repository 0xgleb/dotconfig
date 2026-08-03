import { randomInt, randomUUID } from "node:crypto"
import { chmodSync, mkdirSync } from "node:fs"
import { dirname, isAbsolute } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { Data, Effect, Exit } from "effect"
import {
  cancelJob,
  claimJob,
  completeJob,
  createJob,
  decodeJobSpec,
  decodeStoredJob,
  failJob,
  JobRuntimeError,
  recoverExpiredJob,
  recurringSuccessorSpec,
  REGISTERED_JOB_KINDS,
  type Job,
  type RegisteredJobKind,
  type RegisteredJobResult,
  type RegisteredJobSpec,
} from "./job-runtime.ts"

const SCHEMA_VERSION = 2
const BUSY_TIMEOUT_MS = 2_000
const MAX_JOBS = 10_000

type Row = Readonly<Record<string, unknown>>

export class JobStoreError extends Data.TaggedError("JobStoreError")<{
  readonly code:
    | "busy"
    | "capacity"
    | "corrupt_state"
    | "idempotency_conflict"
    | "invalid_input"
    | "io"
    | "not_found"
    | "schema_mismatch"
  readonly message: string
}> {}

export interface EnqueueResult {
  readonly job: Job
  readonly created: boolean
}

export interface SqliteJobStore {
  readonly enqueue: (
    spec: RegisteredJobSpec,
    id?: string,
    now?: number,
  ) => Effect.Effect<EnqueueResult, JobStoreError | JobRuntimeError>
  readonly get: (id: string) => Effect.Effect<Job, JobStoreError>
  readonly list: () => Effect.Effect<readonly Job[], JobStoreError>
  readonly claimDue: (
    workerId: string,
    leaseToken: string,
    now: number,
    ttlMs: number,
    kinds?: readonly RegisteredJobKind[],
    idempotencyKeys?: readonly string[],
  ) => Effect.Effect<Job | undefined, JobStoreError | JobRuntimeError>
  readonly complete: (
    id: string,
    leaseToken: string,
    now: number,
    summary: string,
    result?: RegisteredJobResult,
  ) => Effect.Effect<Job, JobStoreError | JobRuntimeError>
  readonly fail: (
    id: string,
    leaseToken: string,
    now: number,
    retryDelayMs: number,
    summary: string,
  ) => Effect.Effect<Job, JobStoreError | JobRuntimeError>
  readonly cancel: (
    id: string,
    now: number,
  ) => Effect.Effect<Job, JobStoreError | JobRuntimeError>
  readonly recoverExpired: (
    now: number,
    retryDelayMs: number,
  ) => Effect.Effect<readonly Job[], JobStoreError | JobRuntimeError>
  readonly close: () => void
  readonly unsafeDatabaseForTests: DatabaseSync
}

const storeError = (
  code: JobStoreError["code"],
  message: string,
): JobStoreError => new JobStoreError({ code, message })

const sqliteError = (message: string, error: unknown): JobStoreError => {
  if (error instanceof JobStoreError) return error
  const detail = error instanceof Error ? error.message : ""
  return storeError(
    /busy|locked/i.test(detail) ? "busy" : "io",
    /busy|locked/i.test(detail)
      ? `${message}: database is busy`
      : message,
  )
}

const sql = <A>(
  operation: () => A,
  message: string,
): Effect.Effect<A, JobStoreError> =>
  Effect.try({
    try: operation,
    catch: (cause) => sqliteError(message, cause),
  })

const rowFrom = (value: unknown): Effect.Effect<Row, JobStoreError> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? Effect.succeed(value as Row)
    : Effect.fail(storeError("corrupt_state", "job query returned a malformed row"))

const rowsFrom = (value: unknown): Effect.Effect<readonly Row[], JobStoreError> =>
  Array.isArray(value)
    ? Effect.forEach(value, rowFrom)
    : Effect.fail(storeError("corrupt_state", "job query returned malformed rows"))

const documentFromRow = (row: Row): Effect.Effect<Job, JobStoreError> => {
  if (typeof row.document !== "string")
    return Effect.fail(storeError("corrupt_state", "job document column is malformed"))
  return Effect.flatMap(
    Effect.try({
      try: () => JSON.parse(row.document) as unknown,
      catch: () => storeError("corrupt_state", "job document is malformed JSON"),
    }),
    (decoded) =>
      Effect.mapError(decodeStoredJob(decoded), () =>
        storeError("corrupt_state", "job document violates runtime invariants"),
      ),
  )
}

const exactSpec = (
  left: RegisteredJobSpec,
  right: RegisteredJobSpec,
): boolean => JSON.stringify(left) === JSON.stringify(right)

const validateId = (id: string): Effect.Effect<string, JobStoreError> =>
  /^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/u.test(id)
    ? Effect.succeed(id)
    : Effect.fail(storeError("invalid_input", "job id must be bounded and safe"))

const makeStore = (database: DatabaseSync): SqliteJobStore => {
  const inTransaction = <A, E>(
    operation: Effect.Effect<A, E>,
  ): Effect.Effect<A, E | JobStoreError> =>
    Effect.acquireUseRelease(
      sql(() => database.exec("BEGIN IMMEDIATE"), "failed to begin job transaction"),
      () =>
        Effect.tap(operation, () =>
          sql(() => database.exec("COMMIT"), "failed to commit job transaction"),
        ),
      (_void, exit) =>
        Exit.isFailure(exit)
          ? Effect.catchAll(
              sql(() => database.exec("ROLLBACK"), "failed to roll back job transaction"),
              () => Effect.void,
            )
          : Effect.void,
    )

  const persist = (job: Job): Effect.Effect<Job, JobStoreError> =>
    Effect.flatMap(
      sql(
        () =>
          database
            .prepare(
              `UPDATE jobs
               SET state = ?, run_at = ?, lease_until = ?, updated_at = ?, document = ?
               WHERE job_id = ?`,
            )
            .run(
              job.state,
              job.spec.runAt,
              job.state === "leased" ? job.leaseUntil : null,
              job.updatedAt,
              JSON.stringify(job),
              job.id,
            ),
        "failed to persist job transition",
      ),
      (result) =>
        result.changes === 1
          ? Effect.succeed(job)
          : Effect.fail(storeError("not_found", "job no longer exists")),
    )

  const insertNewJob = (
    job: Job,
  ): Effect.Effect<Job, JobStoreError | JobRuntimeError> =>
    Effect.gen(function* () {
      const countRow = yield* Effect.flatMap(
        sql(
          () => database.prepare("SELECT COUNT(*) AS count FROM jobs").get(),
          "failed to count jobs",
        ),
        rowFrom,
      )
      if (
        typeof countRow.count !== "number" ||
        !Number.isSafeInteger(countRow.count)
      ) {
        return yield* Effect.fail(
          storeError("corrupt_state", "job count is malformed"),
        )
      }
      if (countRow.count >= MAX_JOBS)
        return yield* Effect.fail(
          storeError("capacity", "job store capacity is exhausted"),
        )
      yield* sql(
        () =>
          database
            .prepare(
              `INSERT INTO jobs (
                 job_id, kind, idempotency_key, state, run_at,
                 lease_until, updated_at, document
               ) VALUES (?, ?, ?, ?, ?, NULL, ?, ?)`,
            )
            .run(
              job.id,
              job.spec.kind,
              job.spec.idempotencyKey ?? null,
              job.state,
              job.spec.runAt,
              job.updatedAt,
              JSON.stringify(job),
            ),
        "failed to insert job",
      )
      return job
    })

  const scheduleRecurrence = (
    job: Job,
    now: number,
  ): Effect.Effect<Job, JobStoreError | JobRuntimeError> => {
    if (
      (job.state !== "succeeded" &&
        job.state !== "failed" &&
        job.state !== "cancelled") ||
      job.spec.kind !== "review-duty.scan" ||
      job.spec.recurrence === undefined
    ) {
      return Effect.succeed(job)
    }
    const jitterMs = job.spec.recurrence.jitterMs
    const offset = jitterMs === 0 ? 0 : randomInt(-jitterMs, jitterMs + 1)
    return Effect.gen(function* () {
      const spec = yield* recurringSuccessorSpec(job.spec, now, offset)
      const successor = yield* createJob(spec, randomUUID(), now)
      yield* insertNewJob(successor)
      return job
    })
  }

  const get = (id: string): Effect.Effect<Job, JobStoreError> =>
    Effect.flatMap(validateId(id), (jobId) =>
      Effect.flatMap(
        sql(
          () => database.prepare("SELECT document FROM jobs WHERE job_id = ?").get(jobId),
          "failed to read job",
        ),
        (value) =>
          value === undefined
            ? Effect.fail(storeError("not_found", "job was not found"))
            : Effect.flatMap(rowFrom(value), documentFromRow),
      ),
    )

  const enqueue: SqliteJobStore["enqueue"] = (
    spec,
    id = randomUUID(),
    now = Date.now(),
  ) =>
    Effect.flatMap(decodeJobSpec(spec), (decodedSpec) =>
      Effect.flatMap(validateId(id), (jobId) =>
        inTransaction(
          Effect.gen(function* () {
            const existingValue = decodedSpec.idempotencyKey
              ? yield* sql(
                  () =>
                    database
                      .prepare(
                        `SELECT document FROM jobs
                         WHERE kind = ? AND idempotency_key = ?
                           AND state NOT IN ('succeeded', 'failed', 'cancelled')`,
                      )
                      .get(decodedSpec.kind, decodedSpec.idempotencyKey),
                  "failed to resolve idempotent job",
                )
              : undefined
            if (existingValue !== undefined) {
              const existing = yield* Effect.flatMap(
                rowFrom(existingValue),
                documentFromRow,
              )
              if (!exactSpec(existing.spec, decodedSpec))
                return yield* Effect.fail(
                  storeError(
                    "idempotency_conflict",
                    "idempotency key is already bound to a different job payload",
                  ),
                )
              return { job: existing, created: false }
            }

            const job = yield* createJob(decodedSpec, jobId, now)
            yield* insertNewJob(job)
            return { job, created: true }
          }),
        ),
      ),
    )

  const claimDue: SqliteJobStore["claimDue"] = (
    workerId,
    leaseToken,
    now,
    ttlMs,
    kinds,
    idempotencyKeys,
  ) =>
    inTransaction(
      Effect.gen(function* () {
        if (kinds !== undefined && !isRegisteredKindFilter(kinds)) {
          return yield* Effect.fail(
            storeError(
              "invalid_input",
              "claim kinds must be distinct registered job kinds",
            ),
          )
        }
        if (
          idempotencyKeys !== undefined &&
          !isIdempotencyKeyFilter(idempotencyKeys)
        ) {
          return yield* Effect.fail(
            storeError(
              "invalid_input",
              "claim idempotency keys must be distinct bounded identifiers",
            ),
          )
        }
        const kindFilter =
          kinds === undefined
            ? ""
            : ` AND kind IN (${kinds.map(() => "?").join(", ")})`
        const keyFilter =
          idempotencyKeys === undefined
            ? ""
            : ` AND idempotency_key IN (${idempotencyKeys.map(() => "?").join(", ")})`
        const value = yield* sql(
          () =>
            database
              .prepare(
                `SELECT document FROM jobs
                 WHERE state IN ('scheduled', 'ready', 'retry_wait')
                   AND run_at <= ?${kindFilter}${keyFilter}
                 ORDER BY run_at, updated_at, job_id
                 LIMIT 1`,
              )
              .get(now, ...(kinds ?? []), ...(idempotencyKeys ?? [])),
          "failed to select due job",
        )
        if (value === undefined) return undefined
        const job = yield* Effect.flatMap(rowFrom(value), documentFromRow)
        return yield* Effect.flatMap(
          claimJob(job, workerId, leaseToken, now, ttlMs),
          persist,
        )
      }),
    )

  const complete: SqliteJobStore["complete"] = (
    id,
    leaseToken,
    now,
    summary,
    result,
  ) =>
    inTransaction(
      Effect.flatMap(get(id), (job) =>
        Effect.flatMap(
          Effect.flatMap(
            completeJob(job, leaseToken, now, summary, result),
            persist,
          ),
          (terminal) => scheduleRecurrence(terminal, now),
        ),
      ),
    )

  const fail: SqliteJobStore["fail"] = (
    id,
    leaseToken,
    now,
    retryDelayMs,
    summary,
  ) =>
    inTransaction(
      Effect.flatMap(get(id), (job) =>
        Effect.flatMap(
          Effect.flatMap(
            failJob(job, leaseToken, now, retryDelayMs, summary),
            persist,
          ),
          (transitioned) => scheduleRecurrence(transitioned, now),
        ),
      ),
    )

  const cancel: SqliteJobStore["cancel"] = (id, now) =>
    inTransaction(
      Effect.flatMap(get(id), (job) =>
        Effect.flatMap(Effect.flatMap(cancelJob(job, now), persist), (transitioned) =>
          scheduleRecurrence(transitioned, now),
        ),
      ),
    )

  const recoverExpired: SqliteJobStore["recoverExpired"] = (
    now,
    retryDelayMs,
  ) =>
    inTransaction(
      Effect.gen(function* () {
        const rows = yield* Effect.flatMap(
          sql(
            () =>
              database
                .prepare(
                  `SELECT document FROM jobs
                   WHERE state = 'leased' AND lease_until <= ?
                   ORDER BY lease_until, job_id`,
                )
                .all(now),
            "failed to select expired jobs",
          ),
          rowsFrom,
        )
        return yield* Effect.forEach(rows, (row) =>
          Effect.flatMap(documentFromRow(row), (job) =>
            Effect.flatMap(
              Effect.flatMap(
                recoverExpiredJob(job, now, retryDelayMs),
                persist,
              ),
              (transitioned) => scheduleRecurrence(transitioned, now),
            ),
          ),
        )
      }),
    )

  const list = (): Effect.Effect<readonly Job[], JobStoreError> =>
    Effect.flatMap(
      sql(
        () =>
          database
            .prepare("SELECT document FROM jobs ORDER BY updated_at DESC, job_id")
            .all(),
        "failed to list jobs",
      ),
      (value) =>
        Effect.flatMap(rowsFrom(value), (rows) =>
          Effect.forEach(rows, documentFromRow),
        ),
    )

  return {
    enqueue,
    get,
    list,
    claimDue,
    complete,
    fail,
    cancel,
    recoverExpired,
    close: () => database.close(),
    unsafeDatabaseForTests: database,
  }
}

const SAFE_IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/u
const MAX_CLAIM_KEY_FILTER = 16

export const isIdempotencyKeyFilter = (
  keys: readonly unknown[],
): keys is readonly string[] =>
  keys.length >= 1 &&
  keys.length <= MAX_CLAIM_KEY_FILTER &&
  new Set(keys).size === keys.length &&
  keys.every(
    (key) => typeof key === "string" && SAFE_IDEMPOTENCY_KEY.test(key),
  )

export const isRegisteredKindFilter = (
  kinds: readonly unknown[],
): kinds is readonly RegisteredJobKind[] =>
  kinds.length >= 1 &&
  kinds.length <= REGISTERED_JOB_KINDS.length &&
  new Set(kinds).size === kinds.length &&
  kinds.every((kind) =>
    REGISTERED_JOB_KINDS.includes(kind as RegisteredJobKind),
  )

export const makeSqliteJobStore = (
  path: string,
): Effect.Effect<SqliteJobStore, JobStoreError> => {
  if (!isAbsolute(path) || path.length > 1_024)
    return Effect.fail(
      storeError("invalid_input", "job database path must be a bounded absolute path"),
    )
  return Effect.flatMap(
    sql(() => {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
      const database = new DatabaseSync(path)
      database.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`)
      database.exec("PRAGMA journal_mode = WAL")
      database.exec("PRAGMA foreign_keys = ON")
      const version = database.prepare("PRAGMA user_version").get()
      if (
        typeof version !== "object" ||
        version === null ||
        !("user_version" in version) ||
        typeof version.user_version !== "number"
      ) {
        database.close()
        throw storeError("corrupt_state", "job schema version is malformed")
      }
      if (
        version.user_version !== 0 &&
        version.user_version !== 1 &&
        version.user_version !== SCHEMA_VERSION
      ) {
        database.close()
        throw storeError(
          "schema_mismatch",
          `unsupported job schema version ${version.user_version}`,
        )
      }
      if (version.user_version === 1) {
        database.exec(`
          BEGIN IMMEDIATE;
          DROP INDEX IF EXISTS jobs_due_idx;
          ALTER TABLE jobs RENAME TO jobs_schema_v1;
          CREATE TABLE jobs (
            job_id TEXT PRIMARY KEY,
            kind TEXT NOT NULL,
            idempotency_key TEXT,
            state TEXT NOT NULL,
            run_at INTEGER NOT NULL,
            lease_until INTEGER,
            updated_at INTEGER NOT NULL,
            document TEXT NOT NULL
          );
          INSERT INTO jobs
            SELECT job_id, kind, idempotency_key, state, run_at,
                   lease_until, updated_at, document
            FROM jobs_schema_v1;
          DROP TABLE jobs_schema_v1;
          COMMIT;
        `)
      }
      database.exec(`
        CREATE TABLE IF NOT EXISTS jobs (
          job_id TEXT PRIMARY KEY,
          kind TEXT NOT NULL,
          idempotency_key TEXT,
          state TEXT NOT NULL,
          run_at INTEGER NOT NULL,
          lease_until INTEGER,
          updated_at INTEGER NOT NULL,
          document TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS jobs_due_idx
          ON jobs (state, run_at, updated_at);
        CREATE UNIQUE INDEX IF NOT EXISTS jobs_live_idempotency_idx
          ON jobs (kind, idempotency_key)
          WHERE idempotency_key IS NOT NULL
            AND state NOT IN ('succeeded', 'failed', 'cancelled');
        PRAGMA user_version = ${SCHEMA_VERSION};
      `)
      chmodSync(path, 0o600)
      return database
    }, "failed to initialize job database"),
    (database) => Effect.succeed(makeStore(database)),
  )
}
