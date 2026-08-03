import { randomUUID } from "node:crypto"
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
  type Job,
  type RegisteredJobResult,
  type RegisteredJobSpec,
} from "./job-runtime.ts"
import type { CanonicalPath } from "./review-duty-profile.ts"

const SCHEMA_VERSION = 1
const BUSY_TIMEOUT_MS = 2_000
const MAX_JOBS = 10_000

/**
 * The state a row is moved to once its document no longer decodes. It matches
 * no selection the store makes, so a row that cannot be read stops competing
 * for the next claim or recovery instead of being reconsidered — and refused —
 * on every pass.
 */
const QUARANTINED_STATE = "corrupt"

type Row = Readonly<Record<string, unknown>>

/**
 * A stored row as it reads back. A document that no longer decodes is reported
 * with its identifier and the reason it was refused, so an unreadable row
 * costs the reader that row alone instead of the whole listing.
 */
export type StoredJob =
  | { readonly outcome: "readable"; readonly job: Job }
  | {
      readonly outcome: "unreadable"
      readonly id: string
      readonly reason: string
    }

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
  /**
   * Every stored row, readable or not. An unreadable row is reported in place
   * so a single corrupt document cannot blank the listing.
   */
  readonly list: () => Effect.Effect<readonly StoredJob[], JobStoreError>
  readonly claimDue: (
    workerId: string,
    leaseToken: string,
    now: number,
    ttlMs: number,
  ) => Effect.Effect<Job | undefined, JobStoreError | JobRuntimeError>
  readonly complete: (
    id: string,
    leaseToken: string,
    now: number,
    summary: string,
    result?: RegisteredJobResult,
  ) => Effect.Effect<Job, JobStoreError | JobRuntimeError>
  /**
   * Records an attempt its lease holder could not finish. A harness review
   * passes back the handoff that explains why, and the handoff is stored with
   * the job when the attempt is its last, so the reason outlives the lease.
   */
  readonly fail: (
    id: string,
    leaseToken: string,
    now: number,
    retryDelayMs: number,
    summary: string,
    result?: RegisteredJobResult,
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

const isRecord = (value: unknown): value is Row =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const rowFrom = (value: unknown): Effect.Effect<Row, JobStoreError> =>
  isRecord(value)
    ? Effect.succeed(value)
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

const identifierFromRow = (row: Row): Effect.Effect<string, JobStoreError> =>
  typeof row.job_id === "string"
    ? Effect.succeed(row.job_id)
    : Effect.fail(
        storeError("corrupt_state", "job identifier column is malformed"),
      )

const storedFromRow = (row: Row): Effect.Effect<StoredJob, JobStoreError> =>
  Effect.matchEffect(documentFromRow(row), {
    onFailure: (failure) =>
      Effect.map(identifierFromRow(row), (id) => ({
        outcome: "unreadable" as const,
        id,
        reason: failure.message,
      })),
    onSuccess: (job) => Effect.succeed({ outcome: "readable" as const, job }),
  })

const noJobs: readonly Job[] = []
const oneJob = (job: Job): readonly Job[] => [job]

const exactSpec = (
  left: RegisteredJobSpec,
  right: RegisteredJobSpec,
): boolean => JSON.stringify(left) === JSON.stringify(right)

const validateId = (id: string): Effect.Effect<string, JobStoreError> =>
  /^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/u.test(id)
    ? Effect.succeed(id)
    : Effect.fail(storeError("invalid_input", "job id must be bounded and safe"))

const makeStore = (
  database: DatabaseSync,
  home: CanonicalPath,
): SqliteJobStore => {
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

  /**
   * Moves a row whose document cannot be decoded out of every selection the
   * store makes, so one unreadable job stops blocking the jobs behind it. The
   * document is left untouched: quarantine hides the row from the queue, it
   * does not destroy the evidence of what went wrong.
   */
  const quarantine = (
    row: Row,
    reason: string,
  ): Effect.Effect<void, JobStoreError> =>
    Effect.flatMap(identifierFromRow(row), (id) =>
      Effect.flatMap(
        sql(
          () =>
            database
              .prepare("UPDATE jobs SET state = ? WHERE job_id = ?")
              .run(QUARANTINED_STATE, id),
          "failed to quarantine a corrupt job",
        ),
        (result) =>
          result.changes === 1
            ? Effect.sync(() =>
                console.error(
                  `pi-control-plane quarantined job ${id}: ${reason}`,
                ),
              )
            : Effect.fail(
                storeError(
                  "corrupt_state",
                  "corrupt job could not be quarantined",
                ),
              ),
      ),
    )

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
    Effect.flatMap(decodeJobSpec(spec, home), (decodedSpec) =>
      Effect.flatMap(validateId(id), (jobId) =>
        inTransaction(
          Effect.gen(function* () {
            const existingValue = decodedSpec.idempotencyKey
              ? yield* sql(
                  () =>
                    database
                      .prepare(
                        "SELECT document FROM jobs WHERE kind = ? AND idempotency_key = ?",
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

            const job = yield* createJob(decodedSpec, jobId, now, home)
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
            return { job, created: true }
          }),
        ),
      ),
    )

  /**
   * Leases the job that has been due longest. A row whose document no longer
   * decodes is quarantined and the search continues with the next one, so a
   * single unreadable job cannot hold the front of the queue and starve every
   * worker behind it.
   */
  const claimDue: SqliteJobStore["claimDue"] = (
    workerId,
    leaseToken,
    now,
    ttlMs,
  ) => {
    const claimNextDue = (): Effect.Effect<
      Job | undefined,
      JobStoreError | JobRuntimeError
    > =>
      Effect.flatMap(
        sql(
          () =>
            database
              .prepare(
                `SELECT job_id, document FROM jobs
                 WHERE state IN ('scheduled', 'ready', 'retry_wait')
                   AND run_at <= ?
                 ORDER BY run_at, updated_at, job_id
                 LIMIT 1`,
              )
              .get(now),
          "failed to select due job",
        ),
        (value) =>
          value === undefined
            ? Effect.succeed(undefined)
            : Effect.flatMap(rowFrom(value), (row) =>
                Effect.matchEffect(documentFromRow(row), {
                  onFailure: (failure) =>
                    Effect.flatMap(quarantine(row, failure.message), () =>
                      claimNextDue(),
                    ),
                  onSuccess: (job) =>
                    Effect.flatMap(
                      claimJob(job, workerId, leaseToken, now, ttlMs),
                      persist,
                    ),
                }),
              ),
      )
    return inTransaction(claimNextDue())
  }

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
          completeJob(job, leaseToken, now, summary, result),
          persist,
        ),
      ),
    )

  const fail: SqliteJobStore["fail"] = (
    id,
    leaseToken,
    now,
    retryDelayMs,
    summary,
    result,
  ) =>
    inTransaction(
      Effect.flatMap(get(id), (job) =>
        Effect.flatMap(
          failJob(job, leaseToken, now, retryDelayMs, summary, result),
          persist,
        ),
      ),
    )

  const cancel: SqliteJobStore["cancel"] = (id, now) =>
    inTransaction(
      Effect.flatMap(get(id), (job) =>
        Effect.flatMap(cancelJob(job, now), persist),
      ),
    )

  /**
   * Returns every expired lease to its next attempt. An expired row that no
   * longer decodes is quarantined and left out of the batch instead of failing
   * the recovery of the leases beside it.
   */
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
                  `SELECT job_id, document FROM jobs
                   WHERE state = 'leased' AND lease_until <= ?
                   ORDER BY lease_until, job_id`,
                )
                .all(now),
            "failed to select expired jobs",
          ),
          rowsFrom,
        )
        const recovered = yield* Effect.forEach(rows, (row) =>
          Effect.matchEffect(documentFromRow(row), {
            onFailure: (failure) =>
              Effect.as(quarantine(row, failure.message), noJobs),
            onSuccess: (job) =>
              Effect.map(
                Effect.flatMap(
                  recoverExpiredJob(job, now, retryDelayMs),
                  persist,
                ),
                oneJob,
              ),
          }),
        )
        return recovered.flat()
      }),
    )

  const list = (): Effect.Effect<readonly StoredJob[], JobStoreError> =>
    Effect.flatMap(
      sql(
        () =>
          database
            .prepare(
              "SELECT job_id, document FROM jobs ORDER BY updated_at DESC, job_id",
            )
            .all(),
        "failed to list jobs",
      ),
      (value) =>
        Effect.flatMap(rowsFrom(value), (rows) =>
          Effect.forEach(rows, storedFromRow),
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

/**
 * Opens the job database and binds it to the home its harness payloads are
 * admitted against. The home is a parameter because the registered checkout
 * locations are relative to it: the caller that read the environment decides
 * which home applies rather than the store discovering one.
 */
export const makeSqliteJobStore = (
  path: string,
  home: CanonicalPath,
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
      if (version.user_version !== 0 && version.user_version !== SCHEMA_VERSION) {
        database.close()
        throw storeError(
          "schema_mismatch",
          `unsupported job schema version ${version.user_version}`,
        )
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
          document TEXT NOT NULL,
          UNIQUE (kind, idempotency_key)
        );
        CREATE INDEX IF NOT EXISTS jobs_due_idx
          ON jobs (state, run_at, updated_at);
        PRAGMA user_version = ${SCHEMA_VERSION};
      `)
      chmodSync(path, 0o600)
      return database
    }, "failed to initialize job database"),
    (database) => Effect.succeed(makeStore(database, home)),
  )
}
