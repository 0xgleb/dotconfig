import { Data, Effect } from "effect"
import {
  decodeHarnessResearchHandoff,
  decodeHarnessResearchPayload,
  harnessResearchHandoffMatchesAttempt,
  type HarnessResearchHandoff,
  type HarnessResearchPayload,
} from "./harness-research-protocol.ts"

export type JobId = string & { readonly __brand: "JobId" }

export const toJobId = (value: string): JobId | undefined =>
  /^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/u.test(value)
    ? (value as JobId)
    : undefined

interface JobSchedule {
  readonly runAt: number
  readonly maxAttempts: number
  readonly recurrence?: {
    readonly baseMs: number
    readonly jitterMs: number
  }
  readonly idempotencyKey?: string
}

export interface RegisteredJobPayloads {
  readonly "harness.research": HarnessResearchPayload
}

export type RegisteredJobKind = keyof RegisteredJobPayloads

export type RegisteredJobSpec = {
  readonly [Kind in RegisteredJobKind]: JobSchedule & {
    readonly kind: Kind
    readonly payload: RegisteredJobPayloads[Kind]
  }
}[RegisteredJobKind]

export interface HarnessResearchResult {
  readonly kind: "harness.research"
  readonly handoff: HarnessResearchHandoff
}

export type RegisteredJobResult = HarnessResearchResult

interface JobIdentity {
  readonly id: JobId
  readonly attempt: number
  readonly createdAt: number
  readonly updatedAt: number
}

interface JobBase extends JobIdentity {
  readonly spec: RegisteredJobSpec
}

interface TerminalFields extends JobIdentity {
  readonly finishedAt: number
  readonly summary?: string
}

/**
 * A job waiting for the attempt that follows an unsuccessful one. It carries
 * the summary of the attempt that sent it here, so the reason an attempt
 * stopped survives into the record instead of being discarded the moment a
 * retry is scheduled.
 */
export type RetryingJob = JobBase & {
  readonly state: "retry_wait"
  readonly lastAttemptSummary: string
}

export type Job =
  | (JobBase & { readonly state: "scheduled" | "ready" })
  | RetryingJob
  | (JobBase & {
      readonly state: "leased"
      readonly workerId: string
      readonly leaseToken: string
      readonly leaseUntil: number
      readonly cancelRequestedAt?: number
      readonly result?: never
    })
  | TerminalJob

export type TerminalJob =
  | (TerminalFields & {
      readonly spec: RegisteredJobSpec
      readonly state: "succeeded" | "cancelled"
      readonly result?: RegisteredJobResult
    })
  | (TerminalFields & {
      readonly spec: RegisteredJobSpec
      readonly state: "failed"
      readonly result?: never
    })

/**
 * The typed result a job kept, or nothing when its kind and outcome produce
 * none. Reading the field through this accessor keeps callers from assuming a
 * result exists on a job shape that cannot hold one.
 */
export const jobResult = (job: Job): RegisteredJobResult | undefined => {
  const held: JobIdentity & { readonly result?: RegisteredJobResult } = job
  return held.result
}

export class JobRuntimeError extends Data.TaggedError("JobRuntimeError")<{
  readonly code: "invalid_input" | "invalid_transition" | "stale_lease"
  readonly message: string
}> {}

const MAX_TIMESTAMP = Number.MAX_SAFE_INTEGER
const MAX_ATTEMPTS = 100
const MAX_LEASE_TTL_MS = 24 * 60 * 60 * 1_000
const MAX_RETRY_DELAY_MS = 7 * 24 * 60 * 60 * 1_000
const MIN_RECURRENCE_MS = 60_000
const MAX_RECURRENCE_MS = 7 * 24 * 60 * 60 * 1_000
const SAFE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9:._-]*$/u
const UNSAFE_CONTROL = /[\u{0}-\u{1f}\u{7f}]/u

type LeasedJob = Extract<Job, { readonly state: "leased" }>

const error = (
  code: JobRuntimeError["code"],
  message: string,
): JobRuntimeError => new JobRuntimeError({ code, message })

const invalid = <A>(message: string): Effect.Effect<A, JobRuntimeError> =>
  Effect.fail(error("invalid_input", message))

const invalidTransition = <A>(
  message: string,
): Effect.Effect<A, JobRuntimeError> =>
  Effect.fail(error("invalid_transition", message))

const staleLease = <A>(): Effect.Effect<A, JobRuntimeError> =>
  Effect.fail(error("stale_lease", "lease token is no longer current"))

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const isTimestamp = (value: unknown): value is number =>
  Number.isSafeInteger(value) &&
  Number(value) >= 0 &&
  Number(value) <= MAX_TIMESTAMP

const isBoundedInteger = (
  value: unknown,
  minimum: number,
  maximum: number,
): value is number =>
  Number.isSafeInteger(value) &&
  Number(value) >= minimum &&
  Number(value) <= maximum

const hasOnlyKeys = (
  value: Readonly<Record<string, unknown>>,
  keys: readonly string[],
): boolean => Object.keys(value).every(key => keys.includes(key))

const isSafeIdentifier = (value: unknown, maximum = 256): value is string =>
  typeof value === "string" &&
  value.length >= 1 &&
  value.length <= maximum &&
  SAFE_IDENTIFIER.test(value)

const isSafeSummary = (value: unknown): value is string =>
  typeof value === "string" &&
  value.trim().length >= 1 &&
  value.length <= 4_000 &&
  !UNSAFE_CONTROL.test(value)

const checkedAdd = (left: number, right: number): number | undefined => {
  const sum = left + right
  return isTimestamp(sum) ? sum : undefined
}

type JobPayloadDecoders = {
  readonly [Kind in RegisteredJobKind]: (
    value: unknown,
  ) => Effect.Effect<RegisteredJobPayloads[Kind], JobRuntimeError>
}

const asRuntimeError = <A, E>(
  effect: Effect.Effect<A, E>,
): Effect.Effect<A, JobRuntimeError> =>
  Effect.mapError(effect, failure =>
    error(
      "invalid_input",
      failure instanceof Error ? failure.message : "payload decoder failed",
    ),
  )

const JOB_PAYLOAD_DECODERS: JobPayloadDecoders = {
  "harness.research": value =>
    asRuntimeError(decodeHarnessResearchPayload(value)),
}

export const REGISTERED_JOB_KINDS = Object.freeze(
  Object.keys(JOB_PAYLOAD_DECODERS) as RegisteredJobKind[],
)

const isOneOf = <T extends string>(
  candidates: readonly T[],
  value: unknown,
): value is T =>
  typeof value === "string" && candidates.some(candidate => candidate === value)

export const isRegisteredJobKind = (
  value: unknown,
): value is RegisteredJobKind => isOneOf(REGISTERED_JOB_KINDS, value)

const decodeRegisteredSpec = (
  kind: RegisteredJobKind,
  payload: unknown,
  schedule: JobSchedule,
  decoders: JobPayloadDecoders,
): Effect.Effect<RegisteredJobSpec, JobRuntimeError> =>
  Effect.map(decoders[kind](payload), decoded => ({
    ...schedule,
    kind,
    payload: decoded,
  }))

export const decodeJobSpec = (
  value: unknown,
): Effect.Effect<RegisteredJobSpec, JobRuntimeError> =>
  decodeSpecWith(value, JOB_PAYLOAD_DECODERS)

const decodeSpecWith = (
  value: unknown,
  decoders: JobPayloadDecoders,
): Effect.Effect<RegisteredJobSpec, JobRuntimeError> => {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      "kind",
      "payload",
      "runAt",
      "maxAttempts",
      "recurrence",
      "idempotencyKey",
    ]) ||
    !isRegisteredJobKind(value.kind)
  ) {
    return invalid("job kind must be a registered bounded kind")
  }
  if (!isTimestamp(value.runAt))
    return invalid("runAt must be a safe timestamp")
  if (!isBoundedInteger(value.maxAttempts, 1, MAX_ATTEMPTS))
    return invalid(`maxAttempts must be between 1 and ${MAX_ATTEMPTS}`)
  if (
    value.idempotencyKey !== undefined &&
    !isSafeIdentifier(value.idempotencyKey)
  ) {
    return invalid("idempotencyKey must be a bounded safe identifier")
  }

  let recurrence: JobSchedule["recurrence"]
  if (value.recurrence !== undefined) {
    if (
      !isRecord(value.recurrence) ||
      !hasOnlyKeys(value.recurrence, ["baseMs", "jitterMs"]) ||
      !isBoundedInteger(
        value.recurrence.baseMs,
        MIN_RECURRENCE_MS,
        MAX_RECURRENCE_MS,
      ) ||
      !isBoundedInteger(value.recurrence.jitterMs, 0, MAX_RECURRENCE_MS) ||
      value.recurrence.jitterMs >= value.recurrence.baseMs
    ) {
      return invalid(
        "recurrence requires bounded baseMs and smaller non-negative jitterMs",
      )
    }
    recurrence = {
      baseMs: value.recurrence.baseMs,
      jitterMs: value.recurrence.jitterMs,
    }
  }

  const schedule: JobSchedule = {
    runAt: value.runAt,
    maxAttempts: value.maxAttempts,
    ...(recurrence ? { recurrence } : {}),
    ...(isSafeIdentifier(value.idempotencyKey)
      ? { idempotencyKey: value.idempotencyKey }
      : {}),
  }
  return decodeRegisteredSpec(value.kind, value.payload, schedule, decoders)
}

type JobState = Job["state"]

const BASE_JOB_KEYS = [
  "id",
  "spec",
  "state",
  "attempt",
  "createdAt",
  "updatedAt",
]
const TERMINAL_JOB_KEYS = ["finishedAt", "summary", "result"]

/**
 * The fields each state adds to the shared ones. Keying the table by state
 * makes it exhaustive: a state added to `Job` has to say what it stores before
 * this module compiles, and the accepted states are read back off the table
 * rather than repeated as a second list that can drift from it.
 */
const STATE_JOB_KEYS: Readonly<Record<JobState, readonly string[]>> = {
  scheduled: [],
  ready: [],
  retry_wait: ["lastAttemptSummary"],
  leased: ["workerId", "leaseToken", "leaseUntil", "cancelRequestedAt"],
  succeeded: TERMINAL_JOB_KEYS,
  failed: TERMINAL_JOB_KEYS,
  cancelled: TERMINAL_JOB_KEYS,
}

const JOB_STATES = Object.freeze(Object.keys(STATE_JOB_KEYS) as JobState[])

/**
 * Rebuilds a job from the record the store holds. The fields every state
 * shares are validated once and bound to locals, so the state-specific
 * decoders below read proven values instead of re-asserting the shape of an
 * untyped record.
 */
export const decodeStoredJob = (
  value: unknown,
): Effect.Effect<Job, JobRuntimeError> => {
  if (!isRecord(value)) return invalid("stored job must be an object")
  const state = value.state
  if (!isOneOf(JOB_STATES, state)) return invalid("stored job state is unknown")
  if (!hasOnlyKeys(value, [...BASE_JOB_KEYS, ...STATE_JOB_KEYS[state]]))
    return invalid("stored job contains unknown fields")
  const id = typeof value.id === "string" ? toJobId(value.id) : undefined
  const attempt = value.attempt
  const createdAt = value.createdAt
  const updatedAt = value.updatedAt
  if (
    id === undefined ||
    !isBoundedInteger(attempt, 0, MAX_ATTEMPTS) ||
    !isTimestamp(createdAt) ||
    !isTimestamp(updatedAt) ||
    updatedAt < createdAt
  ) {
    return invalid("stored job base fields are malformed")
  }
  return Effect.flatMap(decodeJobSpec(value.spec), spec => {
    if (attempt > spec.maxAttempts)
      return invalid("stored job attempt exceeds its limit")
    const base: JobBase = { id, spec, attempt, createdAt, updatedAt }
    switch (state) {
      case "scheduled":
        return attempt === 0 && spec.runAt > updatedAt
          ? Effect.succeed({ ...base, state })
          : invalid("stored scheduled job fields are inconsistent")
      case "ready":
        return attempt === 0 && spec.runAt <= updatedAt
          ? Effect.succeed({ ...base, state })
          : invalid("stored ready job fields are inconsistent")
      case "retry_wait":
        return decodeStoredRetry(value, base, state)
      case "leased":
        return decodeStoredLease(value, base, state)
      case "succeeded":
      case "failed":
      case "cancelled":
        return decodeStoredTerminal(value, base, state)
      default:
        return unreachableState(state)
    }
  })
}

const decodeStoredRetry = (
  value: Readonly<Record<string, unknown>>,
  base: JobBase,
  state: "retry_wait",
): Effect.Effect<Job, JobRuntimeError> => {
  const lastAttemptSummary = value.lastAttemptSummary
  return base.attempt >= 1 &&
    base.attempt < base.spec.maxAttempts &&
    base.spec.runAt >= base.updatedAt &&
    isSafeSummary(lastAttemptSummary)
    ? Effect.succeed({ ...base, state, lastAttemptSummary })
    : invalid("stored retrying job fields are inconsistent")
}

const decodeStoredLease = (
  value: Readonly<Record<string, unknown>>,
  base: JobBase,
  state: "leased",
): Effect.Effect<Job, JobRuntimeError> => {
  const workerId = value.workerId
  const leaseToken = value.leaseToken
  const leaseUntil = value.leaseUntil
  const cancelRequestedAt = isTimestamp(value.cancelRequestedAt)
    ? value.cancelRequestedAt
    : undefined
  if (
    base.attempt < 1 ||
    base.spec.runAt > base.updatedAt ||
    !isSafeIdentifier(workerId, 128) ||
    !isSafeIdentifier(leaseToken, 128) ||
    !isTimestamp(leaseUntil) ||
    leaseUntil <= base.createdAt ||
    (value.cancelRequestedAt !== undefined &&
      (cancelRequestedAt === undefined ||
        cancelRequestedAt < base.createdAt ||
        cancelRequestedAt > base.updatedAt))
  ) {
    return invalid("stored leased job fields are malformed")
  }
  return Effect.succeed({
    ...base,
    state,
    workerId,
    leaseToken,
    leaseUntil,
    ...(cancelRequestedAt === undefined ? {} : { cancelRequestedAt }),
  })
}

const decodeStoredTerminal = (
  value: Readonly<Record<string, unknown>>,
  base: JobBase,
  state: "succeeded" | "failed" | "cancelled",
): Effect.Effect<Job, JobRuntimeError> => {
  const spec = base.spec
  const finishedAt = value.finishedAt
  const summary = value.summary
  const cancelledBeforeClaim = state === "cancelled" && base.attempt === 0
  if (
    !isTimestamp(finishedAt) ||
    finishedAt !== base.updatedAt ||
    (state === "succeeded" && base.attempt < 1) ||
    (state === "failed" && base.attempt !== spec.maxAttempts) ||
    ((state === "succeeded" || state === "failed" || base.attempt > 0) &&
      !isSafeSummary(summary)) ||
    (cancelledBeforeClaim && summary !== undefined) ||
    (!cancelledBeforeClaim && spec.runAt > base.updatedAt)
  ) {
    return invalid("stored terminal job fields are malformed")
  }
  const fields: TerminalFields = {
    id: base.id,
    attempt: base.attempt,
    createdAt: base.createdAt,
    updatedAt: base.updatedAt,
    finishedAt,
    ...(isSafeSummary(summary) ? { summary } : {}),
  }
  if (value.result === undefined)
    return Effect.succeed({ ...fields, spec, state })
  if (state === "failed")
    return invalid("a failed job cannot carry a completed research result")
  return Effect.map(
    validatedResearchResult(value.result, spec, base.id, base.attempt),
    result => ({ ...fields, spec, state, result }),
  )
}

/**
 * Refuses a state the dispatch above has no branch for. The parameter is
 * `never`, so a state added to `Job` without a decoder fails to compile rather
 * than falling through to a runtime rejection nobody notices.
 */
const unreachableState = (state: never): Effect.Effect<Job, JobRuntimeError> =>
  invalid(`stored job state ${String(state)} has no decoder`)

export const createJob = (
  spec: RegisteredJobSpec,
  id: string,
  now: number,
): Effect.Effect<Job, JobRuntimeError> => {
  const jobId = toJobId(id)
  if (jobId === undefined) return invalid("job id must be bounded and safe")
  if (!isTimestamp(now)) return invalid("now must be a safe timestamp")
  return Effect.map(decodeJobSpec(spec), decoded => ({
    id: jobId,
    spec: decoded,
    state: decoded.runAt <= now ? "ready" : "scheduled",
    attempt: 0,
    createdAt: now,
    updatedAt: now,
  }))
}

export const claimJob = (
  job: Job,
  workerId: string,
  leaseToken: string,
  now: number,
  ttlMs: number,
): Effect.Effect<Job, JobRuntimeError> => {
  if (!isSafeIdentifier(workerId, 128))
    return invalid("worker id must be bounded and safe")
  if (!isSafeIdentifier(leaseToken, 128))
    return invalid("lease token must be bounded and safe")
  if (!isTimestamp(now)) return invalid("now must be a safe timestamp")
  if (now < job.updatedAt)
    return invalid("now cannot precede the current job state")
  if (!isBoundedInteger(ttlMs, 1, MAX_LEASE_TTL_MS))
    return invalid("lease ttl must be positive and at most 24 hours")
  const leaseUntil = checkedAdd(now, ttlMs)
  if (leaseUntil === undefined)
    return invalid("lease expiry exceeds safe timestamp range")
  if (
    (job.state !== "ready" &&
      job.state !== "scheduled" &&
      job.state !== "retry_wait") ||
    job.spec.runAt > now
  ) {
    return invalidTransition("only due unleased jobs may be claimed")
  }
  if (job.attempt >= job.spec.maxAttempts)
    return invalidTransition("job attempt limit is exhausted")
  return Effect.succeed({
    id: job.id,
    spec: job.spec,
    state: "leased",
    workerId,
    leaseToken,
    leaseUntil,
    attempt: job.attempt + 1,
    createdAt: job.createdAt,
    updatedAt: now,
  })
}

const currentLease = (
  job: Job,
  leaseToken: string,
  now: number,
): Effect.Effect<LeasedJob, JobRuntimeError> => {
  if (job.state !== "leased")
    return invalidTransition("job does not have an active lease")
  if (job.leaseToken !== leaseToken || job.leaseUntil <= now)
    return staleLease()
  return Effect.succeed(job)
}

export const completeJob = (
  job: Job,
  leaseToken: string,
  now: number,
  summary: string,
  result?: RegisteredJobResult,
): Effect.Effect<Job, JobRuntimeError> => {
  if (!isTimestamp(now)) return invalid("now must be a safe timestamp")
  if (now < job.updatedAt)
    return invalid("now cannot precede the current job state")
  if (!isSafeSummary(summary))
    return invalid("summary must be bounded safe text")
  return Effect.flatMap(currentLease(job, leaseToken, now), leased => {
    const fields = terminalFields(leased, now, summary)
    const state =
      leased.cancelRequestedAt === undefined ? "succeeded" : "cancelled"
    if (result === undefined)
      return Effect.succeed({ ...fields, spec: leased.spec, state })
    return Effect.map(
      validatedResearchResult(result, leased.spec, leased.id, leased.attempt),
      validated => ({ ...fields, spec: leased.spec, state, result: validated }),
    )
  })
}

export const failJob = (
  job: Job,
  leaseToken: string,
  now: number,
  retryDelayMs: number,
  summary: string,
): Effect.Effect<Job, JobRuntimeError> => {
  if (!isTimestamp(now)) return invalid("now must be a safe timestamp")
  if (now < job.updatedAt)
    return invalid("now cannot precede the current job state")
  if (!isBoundedInteger(retryDelayMs, 0, MAX_RETRY_DELAY_MS))
    return invalid("retry delay must be bounded to seven days")
  if (checkedAdd(now, retryDelayMs) === undefined)
    return invalid("retry timestamp exceeds safe range")
  if (!isSafeSummary(summary))
    return invalid("summary must be bounded safe text")
  return Effect.map(currentLease(job, leaseToken, now), leased =>
    retryOrFail(leased, now, retryDelayMs, summary),
  )
}

export const cancelJob = (
  job: Job,
  now: number,
): Effect.Effect<Job, JobRuntimeError> => {
  if (!isTimestamp(now)) return invalid("now must be a safe timestamp")
  if (now < job.updatedAt)
    return invalid("now cannot precede the current job state")
  if (
    job.state === "succeeded" ||
    job.state === "failed" ||
    job.state === "cancelled"
  ) {
    return invalidTransition("terminal jobs cannot be cancelled again")
  }
  if (job.state === "leased") {
    if (job.leaseUntil <= now)
      return Effect.succeed({
        id: job.id,
        spec: job.spec,
        state: "cancelled",
        attempt: job.attempt,
        createdAt: job.createdAt,
        updatedAt: now,
        finishedAt: now,
        summary: "cancelled after worker lease expired",
      })
    if (job.cancelRequestedAt !== undefined) return Effect.succeed(job)
    return Effect.succeed({
      ...job,
      cancelRequestedAt: now,
      updatedAt: now,
    })
  }
  return Effect.succeed({
    id: job.id,
    spec: job.spec,
    state: "cancelled",
    attempt: job.attempt,
    createdAt: job.createdAt,
    updatedAt: now,
    finishedAt: now,
  })
}

export const recoverExpiredJob = (
  job: Job,
  now: number,
  retryDelayMs: number,
): Effect.Effect<Job, JobRuntimeError> => {
  if (!isTimestamp(now)) return invalid("now must be a safe timestamp")
  if (now < job.updatedAt)
    return invalid("now cannot precede the current job state")
  if (!isBoundedInteger(retryDelayMs, 0, MAX_RETRY_DELAY_MS))
    return invalid("retry delay must be bounded to seven days")
  if (checkedAdd(now, retryDelayMs) === undefined)
    return invalid("retry timestamp exceeds safe range")
  if (job.state !== "leased" || job.leaseUntil > now)
    return invalidTransition("only expired leases may be recovered")
  return Effect.succeed(
    retryOrFail(job, now, retryDelayMs, "worker lease expired"),
  )
}

const terminalFields = (
  leased: LeasedJob,
  now: number,
  summary: string,
): TerminalFields => ({
  id: leased.id,
  attempt: leased.attempt,
  createdAt: leased.createdAt,
  updatedAt: now,
  finishedAt: now,
  summary,
})

const retryOrFail = (
  leased: LeasedJob,
  now: number,
  retryDelayMs: number,
  summary: string,
): Job => {
  if (
    leased.cancelRequestedAt === undefined &&
    leased.attempt < leased.spec.maxAttempts
  )
    return {
      id: leased.id,
      spec: { ...leased.spec, runAt: now + retryDelayMs },
      state: "retry_wait",
      attempt: leased.attempt,
      createdAt: leased.createdAt,
      updatedAt: now,
      lastAttemptSummary: summary,
    }
  return {
    ...terminalFields(leased, now, summary),
    spec: leased.spec,
    state: leased.cancelRequestedAt === undefined ? "failed" : "cancelled",
  }
}

const validatedResearchResult = (
  value: unknown,
  spec: RegisteredJobSpec,
  jobId: JobId,
  attempt: number,
): Effect.Effect<RegisteredJobResult, JobRuntimeError> => {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["kind", "handoff"]) ||
    value.kind !== "harness.research"
  )
    return invalid("research result must contain its typed handoff")
  return Effect.flatMap(
    asRuntimeError(decodeHarnessResearchHandoff(value.handoff)),
    handoff =>
      harnessResearchHandoffMatchesAttempt(
        handoff,
        spec.payload,
        jobId,
        attempt,
      )
        ? Effect.succeed({ kind: "harness.research", handoff })
        : invalid("research handoff does not match the job attempt"),
  )
}
