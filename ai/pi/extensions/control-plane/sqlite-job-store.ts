import { randomUUID } from "node:crypto"
import { chmodSync, mkdirSync } from "node:fs"
import { dirname, isAbsolute } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { Data, Effect, Exit } from "effect"
import type { RegisteredAgent } from "../agent-registry/registry.ts"
import type { AgentTokenUsage } from "../agent-registry/usage.ts"
import {
  isAllowancePool,
  isAllowanceSource,
  type AllowancePool,
  type ProviderAllowanceCheckpoint,
} from "./allowance-pool.ts"
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
  REGISTERED_JOB_KINDS,
  type Job,
  type RegisteredJobKind,
  type RegisteredJobResult,
  type RegisteredJobSpec,
} from "./job-runtime.ts"
import type { CanonicalPath } from "./review-duty-profile.ts"
import {
  isAllowanceRemainingPercent,
  MAX_ALLOWANCE_PERCENT,
} from "./usage-policy.ts"

const SCHEMA_VERSION = 7
const BUSY_TIMEOUT_MS = 2_000
const MAX_JOBS = 10_000
const USAGE_BUCKET_MS = 15 * 60 * 1_000
const USAGE_RETENTION_MS = 14 * 24 * 60 * 60 * 1_000
const MAX_USAGE_SAMPLES = 5_000
const MAX_ALLOWANCE_CHECKPOINTS = 512
const PROVIDER_QUEUE_STALE_MS = 2 * 60_000
const PROVIDER_QUEUE_RETRY_MS = 5_000
const PROVIDER_RETRY_MAX_JITTER_MS = 30_000

/**
 * The state a row is moved to once its document no longer decodes. It matches
 * no selection the store makes, so a row that cannot be read stops competing
 * for the next claim or recovery instead of being reconsidered — and refused —
 * on every pass.
 */
const QUARANTINED_STATE = "corrupt"

type Row = Readonly<Record<string, unknown>>

const providerRetryJitterMs = (
  reservationId: string,
  maximumMs: number,
): number => {
  const hash = [...reservationId].reduce(
    (current, character) =>
      ((current * 33) ^ (character.codePointAt(0) ?? 0)) >>> 0,
    5_381,
  )

  return hash % (maximumMs + 1)
}

const jitteredProviderRetryAt = (
  retryAt: number,
  now: number,
  reservationId: string,
): number => {
  const delayMs = Math.max(1, retryAt - now)
  const maximumJitterMs = Math.min(
    PROVIDER_RETRY_MAX_JITTER_MS,
    Math.max(250, Math.floor(delayMs / 10)),
  )
  const candidate =
    retryAt + providerRetryJitterMs(reservationId, maximumJitterMs)

  return Number.isSafeInteger(candidate) ? candidate : retryAt
}

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

export interface AgentUsageSample {
  readonly agentId: string
  readonly label: string
  readonly cwd: string
  readonly model?: string
  readonly capturedAt: number
  readonly usage: AgentTokenUsage
}

export type AllowanceCheckpoint = ProviderAllowanceCheckpoint

export type AutonomousAdmission =
  | { readonly allowed: true; readonly admittedAt: number }
  | { readonly allowed: false; readonly retryAt: number }

export type ProviderCallReservation =
  | {
      readonly allowed: true
      readonly reservationId: string
      readonly reservedTokens: number
      readonly expiresAt: number
    }
  | { readonly allowed: false; readonly retryAt: number }

export interface ProviderCallSettlement {
  readonly reservationId: string
  readonly reservedTokens: number
  readonly actualTokens: number
  readonly settledAt: number
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
    kinds?: readonly RegisteredJobKind[],
  ) => Effect.Effect<Job | undefined, JobStoreError | JobRuntimeError>
  readonly claimDueResearch: (
    profile: string,
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
  readonly recordUsage: (
    agents: readonly RegisteredAgent[],
    now: number,
  ) => Effect.Effect<void, JobStoreError>
  readonly listUsage: (
    since: number,
  ) => Effect.Effect<readonly AgentUsageSample[], JobStoreError>
  readonly recordAllowanceCheckpoint: (
    checkpoint: AllowanceCheckpoint,
  ) => Effect.Effect<AllowanceCheckpoint, JobStoreError>
  readonly listAllowanceCheckpoints: (
    since: number,
  ) => Effect.Effect<readonly AllowanceCheckpoint[], JobStoreError>
  readonly claimAutonomousAdmission: (
    role: string,
    now: number,
    fleetMinimumIntervalMs: number,
    roleMinimumIntervalMs: number,
  ) => Effect.Effect<AutonomousAdmission, JobStoreError>
  readonly recordAgentIntervention: (input: {
    readonly agentId: string
    readonly cwd: string
    readonly ownerInteractionAt: number
  }) => Effect.Effect<void, JobStoreError>
  readonly agentIntervention: (
    agentId: string,
  ) => Effect.Effect<number | undefined, JobStoreError>
  readonly reserveProviderCall: (input: {
    readonly reservationId: string
    readonly agentId: string
    readonly role: string
    readonly provider: "openai"
    readonly requestedTokens: number
    readonly capacityTokens: number
    readonly windowMs: number
    readonly minimumIntervalMs: number
    readonly allocationWeight: number
    readonly now: number
  }) => Effect.Effect<ProviderCallReservation, JobStoreError>
  readonly settleProviderCall: (input: {
    readonly reservationId: string
    readonly actualTokens: number
    readonly now: number
  }) => Effect.Effect<ProviderCallSettlement, JobStoreError>
  readonly acquireWorkspaceLock: (
    resource: string,
    owner: string,
    now: number,
    ttlMs: number,
  ) => Effect.Effect<boolean, JobStoreError>
  readonly releaseWorkspaceLock: (
    resource: string,
    owner: string,
  ) => Effect.Effect<void, JobStoreError>
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
    /busy|locked/i.test(detail) ? `${message}: database is busy` : message,
  )
}

const sql = <A>(
  operation: () => A,
  message: string,
): Effect.Effect<A, JobStoreError> =>
  Effect.try({
    try: operation,
    catch: cause => sqliteError(message, cause),
  })

const closeDatabaseBestEffort = (database: DatabaseSync): void => {
  try {
    database.close()
  } catch {
    // Preserve the typed failure that caused initialization to stop.
  }
}

const isRecord = (value: unknown): value is Row =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const rowFrom = (value: unknown): Effect.Effect<Row, JobStoreError> =>
  isRecord(value)
    ? Effect.succeed(value)
    : Effect.fail(
        storeError("corrupt_state", "job query returned a malformed row"),
      )

const rowsFrom = (
  value: unknown,
): Effect.Effect<readonly Row[], JobStoreError> =>
  Array.isArray(value)
    ? Effect.forEach(value, rowFrom)
    : Effect.fail(
        storeError("corrupt_state", "job query returned malformed rows"),
      )

const documentFromRow = (row: Row): Effect.Effect<Job, JobStoreError> => {
  if (typeof row.document !== "string")
    return Effect.fail(
      storeError("corrupt_state", "job document column is malformed"),
    )
  const document = row.document
  return Effect.flatMap(
    Effect.try({
      try: () => JSON.parse(document) as unknown,
      catch: () =>
        storeError("corrupt_state", "job document is malformed JSON"),
    }),
    decoded =>
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
    onFailure: failure =>
      Effect.map(identifierFromRow(row), id => ({
        outcome: "unreadable" as const,
        id,
        reason: failure.message,
      })),
    onSuccess: job => Effect.succeed({ outcome: "readable" as const, job }),
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
    : Effect.fail(
        storeError("invalid_input", "job id must be bounded and safe"),
      )

const boundedText = (
  value: string,
  field: string,
  maximum: number,
): Effect.Effect<string, JobStoreError> =>
  value.length >= 1 &&
  value.length <= maximum &&
  !/[\u0000-\u001f\u007f]/u.test(value)
    ? Effect.succeed(value)
    : Effect.fail(storeError("invalid_input", `${field} must be bounded text`))

const usageCount = (
  value: unknown,
  field: string,
): Effect.Effect<number, JobStoreError> =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? Effect.succeed(value)
    : Effect.fail(storeError("corrupt_state", `${field} usage is malformed`))

const timestamp = (
  value: unknown,
  field: string,
  code: "invalid_input" | "corrupt_state",
): Effect.Effect<number, JobStoreError> =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? Effect.succeed(value)
    : Effect.fail(storeError(code, `${field} timestamp is malformed`))

const remainingPercent = (
  value: unknown,
  code: "invalid_input" | "corrupt_state",
): Effect.Effect<number, JobStoreError> =>
  isAllowanceRemainingPercent(value) && Math.round(value * 100) === value * 100
    ? Effect.succeed(value)
    : Effect.fail(
        storeError(
          code,
          `remaining allowance must be from 0 to ${MAX_ALLOWANCE_PERCENT} with at most two decimals`,
        ),
      )

const allowanceCheckpointFromRow = (
  row: Row,
): Effect.Effect<AllowanceCheckpoint, JobStoreError> =>
  Effect.gen(function* () {
    if (!isAllowancePool(row.provider, row.pool))
      return yield* Effect.fail(
        storeError(
          "corrupt_state",
          "allowance provider and pool are malformed",
        ),
      )
    if (!isAllowanceSource(row.source))
      return yield* Effect.fail(
        storeError("corrupt_state", "allowance source is malformed"),
      )
    const capturedAt = yield* timestamp(
      row.captured_at,
      "allowance capture",
      "corrupt_state",
    )
    const remaining = yield* remainingPercent(
      row.remaining_percent,
      "corrupt_state",
    )
    if (row.event === "refill") {
      if (row.reset_at !== null)
        return yield* Effect.fail(
          storeError("corrupt_state", "refill checkpoint invented a reset"),
        )
      return {
        provider: row.provider,
        pool: row.pool as AllowancePool,
        source: row.source,
        capturedAt,
        remainingPercent: remaining,
        event: "refill",
      }
    }
    if (row.event !== "sample")
      return yield* Effect.fail(
        storeError("corrupt_state", "allowance event is malformed"),
      )
    const resetAt = yield* timestamp(
      row.reset_at,
      "allowance reset",
      "corrupt_state",
    )
    if (resetAt <= capturedAt)
      return yield* Effect.fail(
        storeError("corrupt_state", "allowance reset must follow its capture"),
      )
    return {
      provider: row.provider,
      pool: row.pool as AllowancePool,
      source: row.source,
      capturedAt,
      remainingPercent: remaining,
      resetAt,
    }
  })

const usageSampleFromRow = (
  row: Row,
): Effect.Effect<AgentUsageSample, JobStoreError> =>
  Effect.gen(function* () {
    const agentId = yield* boundedText(
      String(row.agent_id ?? ""),
      "agent id",
      128,
    )
    const label = yield* boundedText(
      String(row.label ?? ""),
      "agent label",
      256,
    )
    const cwd = yield* boundedText(String(row.cwd ?? ""), "agent cwd", 1_024)
    const capturedAt = row.captured_at
    if (
      typeof capturedAt !== "number" ||
      !Number.isSafeInteger(capturedAt) ||
      capturedAt < 0
    )
      return yield* Effect.fail(
        storeError("corrupt_state", "usage sample timestamp is malformed"),
      )
    const model =
      row.model === null || row.model === undefined
        ? undefined
        : yield* boundedText(String(row.model), "agent model", 256)
    return {
      agentId,
      label,
      cwd,
      ...(model ? { model } : {}),
      capturedAt,
      usage: {
        input: yield* usageCount(row.usage_input, "input"),
        output: yield* usageCount(row.usage_output, "output"),
        cacheRead: yield* usageCount(row.usage_cache_read, "cache read"),
        cacheWrite: yield* usageCount(row.usage_cache_write, "cache write"),
        totalTokens: yield* usageCount(row.usage_total, "total token"),
      },
    }
  })

const makeStore = (
  database: DatabaseSync,
  home: CanonicalPath,
): SqliteJobStore => {
  const inTransaction = <A, E>(
    operation: Effect.Effect<A, E>,
  ): Effect.Effect<A, E | JobStoreError> =>
    Effect.acquireUseRelease(
      sql(
        () => database.exec("BEGIN IMMEDIATE"),
        "failed to begin job transaction",
      ),
      () =>
        Effect.tap(operation, () =>
          sql(
            () => database.exec("COMMIT"),
            "failed to commit job transaction",
          ),
        ),
      (_void, exit) =>
        Exit.isFailure(exit)
          ? Effect.catchAll(
              sql(
                () => database.exec("ROLLBACK"),
                "failed to roll back job transaction",
              ),
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
      result =>
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
    Effect.flatMap(identifierFromRow(row), id =>
      Effect.flatMap(
        sql(
          () =>
            database
              .prepare("UPDATE jobs SET state = ? WHERE job_id = ?")
              .run(QUARANTINED_STATE, id),
          "failed to quarantine a corrupt job",
        ),
        result =>
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
    Effect.flatMap(validateId(id), jobId =>
      Effect.flatMap(
        sql(
          () =>
            database
              .prepare("SELECT document FROM jobs WHERE job_id = ?")
              .get(jobId),
          "failed to read job",
        ),
        value =>
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
    Effect.flatMap(decodeJobSpec(spec, home), decodedSpec =>
      Effect.flatMap(validateId(id), jobId =>
        inTransaction(
          Effect.gen(function* () {
            const idempotencyKey = decodedSpec.idempotencyKey
            const existingValue = idempotencyKey
              ? yield* sql(
                  () =>
                    database
                      .prepare(
                        "SELECT document FROM jobs WHERE kind = ? AND idempotency_key = ?",
                      )
                      .get(decodedSpec.kind, idempotencyKey),
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
                () =>
                  database.prepare("SELECT COUNT(*) AS count FROM jobs").get(),
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
    kinds,
  ) => {
    if (kinds?.length === 0) return Effect.succeed(undefined)
    const kindFilter = kinds
      ? ` AND kind IN (${kinds.map(() => "?").join(", ")})`
      : ""
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
                   AND run_at <= ?${kindFilter}
                 ORDER BY run_at, updated_at, job_id
                 LIMIT 1`,
              )
              .get(now, ...(kinds ?? [])),
          "failed to select due job",
        ),
        value =>
          value === undefined
            ? Effect.succeed(undefined)
            : Effect.flatMap(rowFrom(value), row =>
                Effect.matchEffect(documentFromRow(row), {
                  onFailure: failure =>
                    Effect.flatMap(quarantine(row, failure.message), () =>
                      claimNextDue(),
                    ),
                  onSuccess: job =>
                    Effect.flatMap(
                      claimJob(job, workerId, leaseToken, now, ttlMs),
                      persist,
                    ),
                }),
              ),
      )
    return inTransaction(claimNextDue())
  }

  const claimDueResearch: SqliteJobStore["claimDueResearch"] = (
    profile,
    workerId,
    leaseToken,
    now,
    ttlMs,
  ) =>
    Effect.flatMap(validateId(profile), registeredProfile =>
      inTransaction(
        Effect.gen(function* () {
          const value = yield* sql(
            () =>
              database
                .prepare(
                  `SELECT document FROM jobs
                   WHERE kind = 'harness.research'
                     AND state IN ('scheduled', 'ready', 'retry_wait')
                     AND run_at <= ?
                     AND json_extract(document, '$.spec.payload.profile') = ?
                   ORDER BY run_at, updated_at, job_id
                   LIMIT 1`,
                )
                .get(now, registeredProfile),
            "failed to select due research job",
          )
          if (value === undefined) return undefined
          const job = yield* Effect.flatMap(rowFrom(value), documentFromRow)
          return yield* Effect.flatMap(
            claimJob(job, workerId, leaseToken, now, ttlMs),
            persist,
          )
        }),
      ),
    )

  const complete: SqliteJobStore["complete"] = (
    id,
    leaseToken,
    now,
    summary,
    result,
  ) =>
    inTransaction(
      Effect.flatMap(get(id), job =>
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
      Effect.flatMap(get(id), job =>
        Effect.flatMap(
          failJob(job, leaseToken, now, retryDelayMs, summary, result),
          persist,
        ),
      ),
    )

  const cancel: SqliteJobStore["cancel"] = (id, now) =>
    inTransaction(
      Effect.flatMap(get(id), job =>
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
        const recovered = yield* Effect.forEach(rows, row =>
          Effect.matchEffect(documentFromRow(row), {
            onFailure: failure =>
              Effect.as(quarantine(row, failure.message), noJobs),
            onSuccess: job =>
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
      value =>
        Effect.flatMap(rowsFrom(value), rows =>
          Effect.forEach(rows, storedFromRow),
        ),
    )

  const recordUsage: SqliteJobStore["recordUsage"] = (agents, now) =>
    inTransaction(
      Effect.gen(function* () {
        if (!Number.isSafeInteger(now) || now < 0)
          return yield* Effect.fail(
            storeError("invalid_input", "usage capture time is malformed"),
          )
        const capturedAt = Math.floor(now / USAGE_BUCKET_MS) * USAGE_BUCKET_MS
        const statement = database.prepare(
          `INSERT INTO usage_samples (
             agent_id, captured_at, label, cwd, model,
             usage_input, usage_output, usage_cache_read, usage_cache_write, usage_total
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(agent_id, captured_at) DO UPDATE SET
             label = excluded.label,
             cwd = excluded.cwd,
             model = excluded.model,
             usage_input = excluded.usage_input,
             usage_output = excluded.usage_output,
             usage_cache_read = excluded.usage_cache_read,
             usage_cache_write = excluded.usage_cache_write,
             usage_total = excluded.usage_total`,
        )
        yield* Effect.forEach(agents, agent =>
          Effect.gen(function* () {
            const agentId = yield* boundedText(
              agent.identity.id,
              "agent id",
              128,
            )
            const label = yield* boundedText(agent.label, "agent label", 256)
            const cwd = yield* boundedText(agent.cwd, "agent cwd", 1_024)
            const model = agent.identity.model
              ? yield* boundedText(agent.identity.model, "agent model", 256)
              : undefined
            if (
              !Object.values(agent.usage).every(
                count => Number.isSafeInteger(count) && count >= 0,
              )
            )
              return yield* Effect.fail(
                storeError(
                  "invalid_input",
                  "agent usage counters are malformed",
                ),
              )
            yield* sql(
              () =>
                statement.run(
                  agentId,
                  capturedAt,
                  label,
                  cwd,
                  model ?? null,
                  agent.usage.input,
                  agent.usage.output,
                  agent.usage.cacheRead,
                  agent.usage.cacheWrite,
                  agent.usage.totalTokens,
                ),
              "failed to persist agent usage",
            )
          }),
        )
        yield* sql(
          () =>
            database
              .prepare("DELETE FROM usage_samples WHERE captured_at < ?")
              .run(now - USAGE_RETENTION_MS),
          "failed to prune agent usage history",
        )
      }),
    ).pipe(Effect.asVoid)

  const listUsage: SqliteJobStore["listUsage"] = since => {
    if (!Number.isSafeInteger(since) || since < 0)
      return Effect.fail(
        storeError("invalid_input", "usage history boundary is malformed"),
      )
    return Effect.flatMap(
      sql(
        () =>
          database
            .prepare(
              `SELECT * FROM usage_samples
               WHERE captured_at >= ?
               ORDER BY captured_at, agent_id
               LIMIT ?`,
            )
            .all(since, MAX_USAGE_SAMPLES),
        "failed to list agent usage history",
      ),
      value =>
        Effect.flatMap(rowsFrom(value), rows =>
          Effect.forEach(rows, usageSampleFromRow),
        ),
    )
  }

  const recordAllowanceCheckpoint: SqliteJobStore["recordAllowanceCheckpoint"] =
    checkpoint =>
      inTransaction(
        Effect.gen(function* () {
          if (!isAllowancePool(checkpoint.provider, checkpoint.pool))
            return yield* Effect.fail(
              storeError(
                "invalid_input",
                "allowance provider and pool are malformed",
              ),
            )
          if (!isAllowanceSource(checkpoint.source))
            return yield* Effect.fail(
              storeError("invalid_input", "allowance source is malformed"),
            )
          const capturedAt = yield* timestamp(
            checkpoint.capturedAt,
            "allowance capture",
            "invalid_input",
          )
          const resetAt =
            checkpoint.event === "refill"
              ? null
              : yield* timestamp(
                  checkpoint.resetAt,
                  "allowance reset",
                  "invalid_input",
                )
          if (resetAt !== null && resetAt <= capturedAt)
            return yield* Effect.fail(
              storeError(
                "invalid_input",
                "allowance reset must follow its capture",
              ),
            )
          const remaining = yield* remainingPercent(
            checkpoint.remainingPercent,
            "invalid_input",
          )
          yield* sql(
            () =>
              database
                .prepare(
                  `INSERT INTO allowance_checkpoints (
                     provider, pool, source, captured_at, remaining_percent,
                     event, reset_at
                   ) VALUES (?, ?, ?, ?, ?, ?, ?)
                   ON CONFLICT(provider, pool, captured_at) DO UPDATE SET
                     source = excluded.source,
                     remaining_percent = excluded.remaining_percent,
                     event = excluded.event,
                     reset_at = excluded.reset_at`,
                )
                .run(
                  checkpoint.provider,
                  checkpoint.pool,
                  checkpoint.source,
                  capturedAt,
                  remaining,
                  checkpoint.event === "refill" ? "refill" : "sample",
                  resetAt,
                ),
            "failed to record allowance checkpoint",
          )
          yield* sql(
            () =>
              database
                .prepare(
                  `DELETE FROM allowance_checkpoints
                   WHERE (provider, pool, captured_at) NOT IN (
                     SELECT provider, pool, captured_at
                     FROM allowance_checkpoints
                     ORDER BY captured_at DESC, provider, pool
                     LIMIT ?
                   )`,
                )
                .run(MAX_ALLOWANCE_CHECKPOINTS),
            "failed to prune allowance checkpoints",
          )
          const retained = yield* sql(
            () =>
              database
                .prepare(
                  `SELECT 1 FROM allowance_checkpoints
                   WHERE provider = ? AND pool = ? AND captured_at = ?`,
                )
                .get(checkpoint.provider, checkpoint.pool, capturedAt),
            "failed to verify allowance checkpoint retention",
          )
          if (retained === undefined)
            return yield* Effect.fail(
              storeError(
                "capacity",
                "allowance checkpoint is older than retained history",
              ),
            )
          return {
            provider: checkpoint.provider,
            pool: checkpoint.pool,
            source: checkpoint.source,
            capturedAt,
            remainingPercent: remaining,
            ...(checkpoint.event === "refill"
              ? { event: "refill" as const }
              : { resetAt: resetAt as number }),
          }
        }),
      )

  const listAllowanceCheckpoints: SqliteJobStore["listAllowanceCheckpoints"] =
    since => {
      if (!Number.isSafeInteger(since) || since < 0)
        return Effect.fail(
          storeError(
            "invalid_input",
            "allowance history boundary is malformed",
          ),
        )
      return Effect.flatMap(
        sql(
          () =>
            database
              .prepare(
                `SELECT provider, pool, source, captured_at,
                        remaining_percent, event, reset_at
                 FROM allowance_checkpoints
                 WHERE captured_at >= ?
                 ORDER BY captured_at, provider, pool
                 LIMIT ?`,
              )
              .all(since, MAX_ALLOWANCE_CHECKPOINTS),
          "failed to list allowance checkpoints",
        ),
        value =>
          Effect.flatMap(rowsFrom(value), rows =>
            Effect.forEach(rows, allowanceCheckpointFromRow),
          ),
      )
    }

  const claimAutonomousAdmission: SqliteJobStore["claimAutonomousAdmission"] = (
    role,
    now,
    fleetMinimumIntervalMs,
    roleMinimumIntervalMs,
  ) =>
    inTransaction(
      Effect.gen(function* () {
        const admittedAt = yield* timestamp(
          now,
          "autonomous admission",
          "invalid_input",
        )
        const intervals = [fleetMinimumIntervalMs, roleMinimumIntervalMs]
        if (
          !/^(?:general|reviewer|yielduck-operator|moneymentum-operator)$/u.test(
            role,
          ) ||
          intervals.some(
            interval =>
              !Number.isSafeInteger(interval) ||
              interval < 0 ||
              interval > 7 * 24 * 60 * 60 * 1_000,
          )
        )
          return yield* Effect.fail(
            storeError(
              "invalid_input",
              "autonomous admission policy is malformed",
            ),
          )
        const rows = yield* sql(
          () =>
            database
              .prepare(
                `SELECT role, admitted_at
                   FROM usage_admission
                   WHERE role IN ('fleet', ?)`,
              )
              .all(role),
          "failed to read autonomous admission",
        )
        let retryAt = admittedAt
        for (const value of yield* rowsFrom(rows)) {
          const row = yield* rowFrom(value)
          if (typeof row.role !== "string")
            return yield* Effect.fail(
              storeError(
                "corrupt_state",
                "persisted autonomous role is malformed",
              ),
            )
          const previous = yield* timestamp(
            row.admitted_at,
            "persisted autonomous admission",
            "corrupt_state",
          )
          const interval =
            row.role === "fleet"
              ? fleetMinimumIntervalMs
              : roleMinimumIntervalMs
          const candidate = previous + interval
          if (!Number.isSafeInteger(candidate))
            return yield* Effect.fail(
              storeError(
                "corrupt_state",
                "autonomous admission retry overflowed",
              ),
            )
          retryAt = Math.max(retryAt, candidate)
        }
        if (admittedAt < retryAt) return { allowed: false, retryAt }
        yield* sql(() => {
          const statement = database.prepare(
            `INSERT INTO usage_admission (role, admitted_at)
                 VALUES (?, ?)
                 ON CONFLICT(role) DO UPDATE SET admitted_at = excluded.admitted_at`,
          )
          statement.run("fleet", admittedAt)
          statement.run(role, admittedAt)
        }, "failed to persist autonomous admission")
        return { allowed: true, admittedAt }
      }),
    )

  const recordAgentIntervention: SqliteJobStore["recordAgentIntervention"] =
    input =>
      Effect.gen(function* () {
        const agentId = yield* boundedText(input.agentId, "agent id", 160)
        const cwd = yield* boundedText(input.cwd, "agent cwd", 1_024)
        const ownerInteractionAt = yield* timestamp(
          input.ownerInteractionAt,
          "owner interaction",
          "invalid_input",
        )
        if (!isAbsolute(cwd))
          return yield* Effect.fail(
            storeError("invalid_input", "agent cwd must be an absolute path"),
          )
        yield* sql(
          () =>
            database
              .prepare(
                `INSERT INTO agent_interventions (
                   agent_id, cwd, owner_interaction_at
                 ) VALUES (?, ?, ?)
                 ON CONFLICT(agent_id) DO UPDATE SET
                   cwd = excluded.cwd,
                   owner_interaction_at = excluded.owner_interaction_at
                 WHERE excluded.owner_interaction_at >= agent_interventions.owner_interaction_at`,
              )
              .run(agentId, cwd, ownerInteractionAt),
          "failed to persist agent intervention",
        )
      })

  const agentIntervention: SqliteJobStore["agentIntervention"] = agentId =>
    Effect.gen(function* () {
      const validatedAgentId = yield* boundedText(agentId, "agent id", 160)
      const value = yield* sql(
        () =>
          database
            .prepare(
              `SELECT owner_interaction_at
               FROM agent_interventions
               WHERE agent_id = ?`,
            )
            .get(validatedAgentId),
        "failed to read agent intervention",
      )
      if (value === undefined) return undefined
      const row = yield* rowFrom(value)
      return yield* timestamp(
        row.owner_interaction_at,
        "owner interaction",
        "corrupt_state",
      )
    })

  const reserveProviderCall: SqliteJobStore["reserveProviderCall"] = input =>
    Effect.flatMap(validateId(input.reservationId), reservationId =>
      inTransaction(
        Effect.gen(function* () {
          const agentId = yield* boundedText(input.agentId, "agent id", 160)
          const now = yield* timestamp(
            input.now,
            "provider call reservation",
            "invalid_input",
          )
          if (
            input.provider !== "openai" ||
            !/^(?:general|reviewer|yielduck-operator|moneymentum-operator)$/u.test(
              input.role,
            ) ||
            !Number.isSafeInteger(input.requestedTokens) ||
            input.requestedTokens < 1 ||
            input.requestedTokens > 2_000_000 ||
            !Number.isSafeInteger(input.capacityTokens) ||
            input.capacityTokens < 1 ||
            input.capacityTokens > 2_000_000_000 ||
            !Number.isSafeInteger(input.windowMs) ||
            input.windowMs < 60_000 ||
            input.windowMs > 7 * 24 * 60 * 60 * 1_000 ||
            !Number.isSafeInteger(input.minimumIntervalMs) ||
            input.minimumIntervalMs < 0 ||
            input.minimumIntervalMs > 7 * 24 * 60 * 60 * 1_000 ||
            !Number.isFinite(input.allocationWeight) ||
            input.allocationWeight < 0.01 ||
            input.allocationWeight > 100
          )
            return yield* Effect.fail(
              storeError(
                "invalid_input",
                "provider call reservation is malformed",
              ),
            )
          const existing = yield* sql(
            () =>
              database
                .prepare(
                  `SELECT agent_id, role, provider, reserved_tokens, actual_tokens,
                          expires_at
                   FROM provider_call_reservations
                   WHERE reservation_id = ?`,
                )
                .get(reservationId),
            "failed to read provider call reservation",
          )
          if (existing !== undefined) {
            const row = yield* rowFrom(existing)
            if (
              row.agent_id !== agentId ||
              row.role !== input.role ||
              row.provider !== input.provider ||
              row.reserved_tokens !== input.requestedTokens
            )
              return yield* Effect.fail(
                storeError(
                  "idempotency_conflict",
                  "provider call reservation id was reused with different input",
                ),
              )
            const expiresAt = yield* timestamp(
              row.expires_at,
              "provider call reservation expiry",
              "corrupt_state",
            )
            return row.actual_tokens === null && expiresAt > now
              ? {
                  allowed: true as const,
                  reservationId,
                  reservedTokens: input.requestedTokens,
                  expiresAt,
                }
              : {
                  allowed: false as const,
                  retryAt: Math.max(now + 1, expiresAt),
                }
          }

          yield* sql(() => {
            database
              .prepare(
                `DELETE FROM provider_call_queue
                 WHERE last_seen_at < ?`,
              )
              .run(Math.max(0, now - PROVIDER_QUEUE_STALE_MS))
            database
              .prepare(
                `INSERT INTO provider_call_queue (
                   reservation_id, agent_id, role, requested_tokens,
                   allocation_weight, enqueued_at, last_seen_at
                 ) VALUES (?, ?, ?, ?, ?, ?, ?)
                 ON CONFLICT(reservation_id) DO UPDATE SET
                   last_seen_at = excluded.last_seen_at
                 WHERE agent_id = excluded.agent_id
                   AND role = excluded.role
                   AND requested_tokens = excluded.requested_tokens
                   AND allocation_weight = excluded.allocation_weight`,
              )
              .run(
                reservationId,
                agentId,
                input.role,
                input.requestedTokens,
                input.allocationWeight,
                now,
                now,
              )
          }, "failed to maintain provider call queue")

          const queuedHead = yield* sql(
            () =>
              database
                .prepare(
                  `SELECT reservation_id
                   FROM provider_call_queue
                   ORDER BY ((? - enqueued_at) * allocation_weight) DESC,
                            enqueued_at ASC,
                            reservation_id ASC
                   LIMIT 1`,
                )
                .get(now),
            "failed to read provider call queue",
          )
          const queuedHeadRow = yield* rowFrom(queuedHead)

          if (queuedHeadRow.reservation_id !== reservationId) {
            const retryAt = now + PROVIDER_QUEUE_RETRY_MS

            return {
              allowed: false as const,
              retryAt: jitteredProviderRetryAt(retryAt, now, reservationId),
            }
          }

          const windowStart = Math.max(0, now - input.windowMs)
          const usage = yield* sql(
            () =>
              database
                .prepare(
                  `SELECT
                     COALESCE(SUM(
                       CASE
                         WHEN actual_tokens IS NOT NULL THEN actual_tokens
                         ELSE reserved_tokens
                       END
                     ), 0) AS used_tokens,
                     MIN(created_at + ?) AS retry_at,
                     MAX(created_at) AS latest_created_at
                   FROM provider_call_reservations
                   WHERE created_at >= ?`,
                )
                .get(input.windowMs, windowStart),
            "failed to calculate provider call budget",
          )
          const usageRow = yield* rowFrom(usage)

          if (
            typeof usageRow.used_tokens !== "number" ||
            !Number.isSafeInteger(usageRow.used_tokens) ||
            usageRow.used_tokens < 0
          )
            return yield* Effect.fail(
              storeError("corrupt_state", "provider token spend is malformed"),
            )

          if (
            typeof usageRow.latest_created_at === "number" &&
            Number.isSafeInteger(usageRow.latest_created_at) &&
            usageRow.latest_created_at + input.minimumIntervalMs > now
          ) {
            const retryAt = usageRow.latest_created_at + input.minimumIntervalMs

            return {
              allowed: false as const,
              retryAt: jitteredProviderRetryAt(retryAt, now, reservationId),
            }
          }

          if (
            usageRow.used_tokens + input.requestedTokens >
            input.capacityTokens
          ) {
            const retryAt =
              typeof usageRow.retry_at === "number" &&
              Number.isSafeInteger(usageRow.retry_at) &&
              usageRow.retry_at > now
                ? usageRow.retry_at
                : now + 60_000

            return {
              allowed: false as const,
              retryAt: jitteredProviderRetryAt(retryAt, now, reservationId),
            }
          }

          const expiresAt = now + 15 * 60 * 1_000
          if (!Number.isSafeInteger(expiresAt))
            return yield* Effect.fail(
              storeError(
                "invalid_input",
                "provider reservation ttl overflowed",
              ),
            )

          yield* sql(() => {
            database
              .prepare(
                `INSERT INTO provider_call_reservations (
                   reservation_id, agent_id, role, provider, reserved_tokens,
                   actual_tokens, created_at, expires_at, settled_at
                 ) VALUES (?, ?, ?, ?, ?, NULL, ?, ?, NULL)`,
              )
              .run(
                reservationId,
                agentId,
                input.role,
                input.provider,
                input.requestedTokens,
                now,
                expiresAt,
              )
            database
              .prepare(
                `DELETE FROM provider_call_queue WHERE reservation_id = ?`,
              )
              .run(reservationId)
          }, "failed to persist provider call reservation")
          return {
            allowed: true as const,
            reservationId,
            reservedTokens: input.requestedTokens,
            expiresAt,
          }
        }),
      ),
    )

  const settleProviderCall: SqliteJobStore["settleProviderCall"] = input =>
    Effect.flatMap(validateId(input.reservationId), reservationId =>
      inTransaction(
        Effect.gen(function* () {
          const settledAt = yield* timestamp(
            input.now,
            "provider call settlement",
            "invalid_input",
          )
          if (
            !Number.isSafeInteger(input.actualTokens) ||
            input.actualTokens < 0 ||
            input.actualTokens > 2_000_000
          )
            return yield* Effect.fail(
              storeError("invalid_input", "provider call usage is malformed"),
            )
          const existing = yield* sql(
            () =>
              database
                .prepare(
                  `SELECT reserved_tokens, actual_tokens, settled_at
                   FROM provider_call_reservations
                   WHERE reservation_id = ?`,
                )
                .get(reservationId),
            "failed to read provider call settlement",
          )
          if (existing === undefined)
            return yield* Effect.fail(
              storeError(
                "not_found",
                "provider call reservation was not found",
              ),
            )
          const row = yield* rowFrom(existing)
          const reservedTokens = yield* usageCount(
            row.reserved_tokens,
            "provider call reserved token",
          )
          if (row.actual_tokens !== null) {
            const actualTokens = yield* usageCount(
              row.actual_tokens,
              "provider call settled token",
            )
            if (actualTokens !== input.actualTokens)
              return yield* Effect.fail(
                storeError(
                  "idempotency_conflict",
                  "provider call settlement changed recorded usage",
                ),
              )
            const priorSettledAt = yield* timestamp(
              row.settled_at,
              "provider call prior settlement",
              "corrupt_state",
            )
            return {
              reservationId,
              reservedTokens,
              actualTokens,
              settledAt: priorSettledAt,
            }
          }
          yield* sql(
            () =>
              database
                .prepare(
                  `UPDATE provider_call_reservations
                   SET actual_tokens = ?, settled_at = ?
                   WHERE reservation_id = ? AND actual_tokens IS NULL`,
                )
                .run(input.actualTokens, settledAt, reservationId),
            "failed to persist provider call settlement",
          )
          return {
            reservationId,
            reservedTokens,
            actualTokens: input.actualTokens,
            settledAt,
          }
        }),
      ),
    )

  const acquireWorkspaceLock: SqliteJobStore["acquireWorkspaceLock"] = (
    resource,
    owner,
    now,
    ttlMs,
  ) =>
    Effect.flatMap(validateId(resource), lockResource =>
      Effect.flatMap(validateId(owner), lockOwner =>
        inTransaction(
          Effect.gen(function* () {
            const acquiredAt = yield* timestamp(
              now,
              "workspace lock",
              "invalid_input",
            )
            if (
              !Number.isSafeInteger(ttlMs) ||
              ttlMs < 1 ||
              ttlMs > 120_000 ||
              !Number.isSafeInteger(acquiredAt + ttlMs)
            )
              return yield* Effect.fail(
                storeError("invalid_input", "workspace lock ttl is malformed"),
              )
            const current = yield* sql(
              () =>
                database
                  .prepare(
                    "SELECT owner, expires_at FROM workspace_locks WHERE resource = ?",
                  )
                  .get(lockResource),
              "failed to read workspace lock",
            )
            if (current !== undefined) {
              const row = yield* rowFrom(current)
              const expiresAt = yield* timestamp(
                row.expires_at,
                "persisted workspace lock expiry",
                "corrupt_state",
              )
              if (expiresAt > acquiredAt && row.owner !== lockOwner)
                return false
            }
            yield* sql(
              () =>
                database
                  .prepare(
                    `INSERT INTO workspace_locks (resource, owner, expires_at)
                     VALUES (?, ?, ?)
                     ON CONFLICT(resource) DO UPDATE SET
                       owner = excluded.owner,
                       expires_at = excluded.expires_at`,
                  )
                  .run(lockResource, lockOwner, acquiredAt + ttlMs),
              "failed to persist workspace lock",
            )
            return true
          }),
        ),
      ),
    )

  const releaseWorkspaceLock: SqliteJobStore["releaseWorkspaceLock"] = (
    resource,
    owner,
  ) =>
    Effect.flatMap(validateId(resource), lockResource =>
      Effect.flatMap(validateId(owner), lockOwner =>
        Effect.asVoid(
          sql(
            () =>
              database
                .prepare(
                  "DELETE FROM workspace_locks WHERE resource = ? AND owner = ?",
                )
                .run(lockResource, lockOwner),
            "failed to release workspace lock",
          ),
        ),
      ),
    )

  return {
    enqueue,
    get,
    list,
    claimDue,
    claimDueResearch,
    complete,
    fail,
    cancel,
    recoverExpired,
    recordUsage,
    listUsage,
    recordAllowanceCheckpoint,
    listAllowanceCheckpoints,
    claimAutonomousAdmission,
    recordAgentIntervention,
    agentIntervention,
    reserveProviderCall,
    settleProviderCall,
    acquireWorkspaceLock,
    releaseWorkspaceLock,
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
      storeError(
        "invalid_input",
        "job database path must be a bounded absolute path",
      ),
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
        closeDatabaseBestEffort(database)
        return {
          status: "failed" as const,
          error: storeError("corrupt_state", "job schema version is malformed"),
        }
      }
      if (
        ![0, 1, 2, 3, 4, 5, 6, SCHEMA_VERSION].includes(version.user_version)
      ) {
        closeDatabaseBestEffort(database)
        return {
          status: "failed" as const,
          error: storeError(
            "schema_mismatch",
            `unsupported job schema version ${version.user_version}`,
          ),
        }
      }
      const hasLegacyAllowanceTable =
        database
          .prepare(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'allowance_checkpoints'",
          )
          .get() !== undefined
      const migrateAllowanceTable =
        version.user_version > 0 &&
        version.user_version <= 2 &&
        hasLegacyAllowanceTable
          ? `
            ALTER TABLE allowance_checkpoints RENAME TO allowance_checkpoints_legacy;
            CREATE TABLE allowance_checkpoints (
              provider TEXT NOT NULL,
              pool TEXT NOT NULL,
              source TEXT NOT NULL,
              captured_at INTEGER NOT NULL,
              remaining_percent REAL NOT NULL,
              event TEXT NOT NULL,
              reset_at INTEGER,
              PRIMARY KEY (provider, pool, captured_at)
            );
            INSERT INTO allowance_checkpoints (
              provider, pool, source, captured_at, remaining_percent,
              event, reset_at
            )
            SELECT 'legacy', 'generic', 'legacy-import',
                   captured_at, remaining_percent, 'sample', reset_at
            FROM allowance_checkpoints_legacy;
            DROP TABLE allowance_checkpoints_legacy;
          `
          : ""
      const reclassifyCodexAppServer =
        version.user_version === 3 && hasLegacyAllowanceTable
          ? `
            UPDATE allowance_checkpoints
            SET pool = 'codex-app-server-weekly'
            WHERE provider = 'openai'
              AND pool = 'chatgpt-shared-weekly'
              AND source = 'codex-app-server';
          `
          : ""
      const migrateAllowanceEvents =
        version.user_version >= 3 &&
        version.user_version <= 5 &&
        hasLegacyAllowanceTable
          ? `
            ALTER TABLE allowance_checkpoints RENAME TO allowance_checkpoints_pre_events;
            CREATE TABLE allowance_checkpoints (
              provider TEXT NOT NULL,
              pool TEXT NOT NULL,
              source TEXT NOT NULL,
              captured_at INTEGER NOT NULL,
              remaining_percent REAL NOT NULL,
              event TEXT NOT NULL,
              reset_at INTEGER,
              PRIMARY KEY (provider, pool, captured_at)
            );
            INSERT INTO allowance_checkpoints (
              provider, pool, source, captured_at, remaining_percent,
              event, reset_at
            )
            SELECT provider, pool, source, captured_at, remaining_percent,
                   'sample', reset_at
            FROM allowance_checkpoints_pre_events;
            DROP TABLE allowance_checkpoints_pre_events;
          `
          : ""
      const migrateUsageAdmission =
        version.user_version > 0 && version.user_version <= 4
          ? `
            DROP TABLE IF EXISTS usage_admission;
          `
          : ""
      const migrateProviderAllocation =
        version.user_version === 6
          ? `
            ALTER TABLE provider_call_reservations
              ADD COLUMN agent_id TEXT NOT NULL DEFAULT 'legacy';
            ALTER TABLE provider_call_queue
              ADD COLUMN agent_id TEXT NOT NULL DEFAULT 'legacy';
            ALTER TABLE provider_call_queue
              ADD COLUMN allocation_weight REAL NOT NULL DEFAULT 1;
          `
          : ""
      try {
        database.exec(`
        BEGIN IMMEDIATE;
        ${migrateAllowanceTable}
        ${reclassifyCodexAppServer}
        ${migrateAllowanceEvents}
        ${migrateUsageAdmission}
        ${migrateProviderAllocation}
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
        CREATE TABLE IF NOT EXISTS usage_samples (
          agent_id TEXT NOT NULL,
          captured_at INTEGER NOT NULL,
          label TEXT NOT NULL,
          cwd TEXT NOT NULL,
          model TEXT,
          usage_input INTEGER NOT NULL,
          usage_output INTEGER NOT NULL,
          usage_cache_read INTEGER NOT NULL,
          usage_cache_write INTEGER NOT NULL,
          usage_total INTEGER NOT NULL,
          PRIMARY KEY (agent_id, captured_at)
        );
        CREATE INDEX IF NOT EXISTS usage_samples_time_idx
          ON usage_samples (captured_at, agent_id);
        CREATE TABLE IF NOT EXISTS allowance_checkpoints (
          provider TEXT NOT NULL,
          pool TEXT NOT NULL,
          source TEXT NOT NULL,
          captured_at INTEGER NOT NULL,
          remaining_percent REAL NOT NULL,
          event TEXT NOT NULL,
          reset_at INTEGER,
          PRIMARY KEY (provider, pool, captured_at)
        );
        CREATE INDEX IF NOT EXISTS allowance_checkpoints_reset_idx
          ON allowance_checkpoints (provider, pool, reset_at, captured_at);
        CREATE TABLE IF NOT EXISTS usage_admission (
          role TEXT PRIMARY KEY,
          admitted_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS agent_interventions (
          agent_id TEXT PRIMARY KEY,
          cwd TEXT NOT NULL,
          owner_interaction_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS provider_call_reservations (
          reservation_id TEXT PRIMARY KEY,
          agent_id TEXT NOT NULL,
          role TEXT NOT NULL,
          provider TEXT NOT NULL,
          reserved_tokens INTEGER NOT NULL,
          actual_tokens INTEGER,
          created_at INTEGER NOT NULL,
          expires_at INTEGER NOT NULL,
          settled_at INTEGER
        );
        CREATE INDEX IF NOT EXISTS provider_call_reservations_time_idx
          ON provider_call_reservations (created_at, expires_at);
        CREATE TABLE IF NOT EXISTS provider_call_queue (
          reservation_id TEXT PRIMARY KEY,
          agent_id TEXT NOT NULL,
          role TEXT NOT NULL,
          requested_tokens INTEGER NOT NULL,
          allocation_weight REAL NOT NULL,
          enqueued_at INTEGER NOT NULL,
          last_seen_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS provider_call_queue_order_idx
          ON provider_call_queue (enqueued_at, reservation_id);
        CREATE TABLE IF NOT EXISTS workspace_locks (
          resource TEXT PRIMARY KEY,
          owner TEXT NOT NULL,
          expires_at INTEGER NOT NULL
        );
        PRAGMA user_version = ${SCHEMA_VERSION};
        COMMIT;
      `)
      } catch (error) {
        try {
          database.exec("ROLLBACK")
        } catch {}
        closeDatabaseBestEffort(database)
        return {
          status: "failed" as const,
          error: sqliteError("failed to initialize job database", error),
        }
      }
      chmodSync(path, 0o600)
      return { status: "opened" as const, database }
    }, "failed to initialize job database"),
    outcome =>
      outcome.status === "opened"
        ? Effect.succeed(makeStore(outcome.database, home))
        : Effect.fail(outcome.error),
  )
}
