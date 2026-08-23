import { Data, Effect } from "effect"
import {
  decodeHarnessReviewHandoff,
  decodeHarnessReviewPayload,
  harnessHandoffMatchesAttempt,
  type HarnessReviewHandoff,
  type HarnessReviewPayload,
} from "./harness-protocol.ts"
import {
  decodeHarnessResearchHandoff,
  decodeHarnessResearchPayload,
  harnessResearchHandoffMatchesAttempt,
  type HarnessResearchHandoff,
  type HarnessResearchPayload,
} from "./harness-research-protocol.ts"
import {
  REVIEW_DUTY_PROFILES,
  type ReviewDutyProfile,
} from "./review-duty-profile.ts"

export {
  REVIEW_DUTY_PROFILES,
  type ReviewDutyProfile,
} from "./review-duty-profile.ts"

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
  readonly "review-duty.scan": { readonly profile: ReviewDutyProfile }
  readonly "harness.review": HarnessReviewPayload
  readonly "harness.research": HarnessResearchPayload
}

export type RegisteredJobKind = keyof RegisteredJobPayloads

export type RegisteredJobSpec = {
  readonly [Kind in RegisteredJobKind]: JobSchedule & {
    readonly kind: Kind
    readonly payload: RegisteredJobPayloads[Kind]
  }
}[RegisteredJobKind]

export type ReviewDutyScanSpec = Extract<
  RegisteredJobSpec,
  { readonly kind: "review-duty.scan" }
>

export type HarnessReviewSpec = Extract<
  RegisteredJobSpec,
  { readonly kind: "harness.review" }
>

export type HarnessResearchSpec = Extract<
  RegisteredJobSpec,
  { readonly kind: "harness.research" }
>

export interface HarnessReviewResult {
  readonly kind: "harness.review"
  readonly handoff: HarnessReviewHandoff
}

export interface HarnessResearchResult {
  readonly kind: "harness.research"
  readonly handoff: HarnessResearchHandoff
}

export type RegisteredJobResult = HarnessReviewResult | HarnessResearchResult

interface JobBase {
  readonly id: string
  readonly spec: RegisteredJobSpec
  readonly attempt: number
  readonly createdAt: number
  readonly updatedAt: number
}

/**
 * Terminal results are correlated with the job kind at the type level: a
 * successful harness job must carry its typed result, a cancelled harness
 * job may carry one, and every other state/kind combination rejects the
 * `result` property outright via `never`.
 */
export type Job =
  | (JobBase & {
      readonly state: "scheduled" | "ready" | "retry_wait"
      readonly result?: never
    })
  | (JobBase & {
      readonly state: "leased"
      readonly workerId: string
      readonly leaseToken: string
      readonly leaseUntil: number
      readonly cancelRequestedAt?: number
      readonly result?: never
    })
  | (JobBase & {
      readonly state: "failed"
      readonly finishedAt: number
      readonly summary: string
      readonly result?: never
    })
  | (JobBase & {
      readonly state: "cancelled"
      readonly finishedAt: number
      readonly summary?: string
      readonly result?: never
    })
  | (JobBase & {
      readonly spec: HarnessReviewSpec
      readonly state: "succeeded" | "cancelled"
      readonly finishedAt: number
      readonly summary: string
      readonly result: HarnessReviewResult
    })
  | (JobBase & {
      readonly spec: HarnessResearchSpec
      readonly state: "succeeded" | "cancelled"
      readonly finishedAt: number
      readonly summary: string
      readonly result: HarnessResearchResult
    })
  | (JobBase & {
      readonly spec: ReviewDutyScanSpec
      readonly state: "succeeded"
      readonly finishedAt: number
      readonly summary: string
      readonly result?: never
    })

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
const UNSAFE_CONTROL = /[\u0000-\u001f\u007f]/u

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

type PayloadDecoder<Kind extends RegisteredJobKind> = (
  value: unknown,
) => Effect.Effect<RegisteredJobPayloads[Kind], JobRuntimeError>

const REGISTERED_JOB_PAYLOAD_DECODERS: {
  readonly [Kind in RegisteredJobKind]: PayloadDecoder<Kind>
} = {
  "review-duty.scan": value =>
    isRecord(value) &&
    hasOnlyKeys(value, ["profile"]) &&
    REVIEW_DUTY_PROFILES.includes(value.profile as ReviewDutyProfile)
      ? Effect.succeed({ profile: value.profile as ReviewDutyProfile })
      : invalid("review-duty.scan requires a registered profile"),
  "harness.review": value =>
    Effect.mapError(decodeHarnessReviewPayload(value), () =>
      error("invalid_input", "harness.review payload is invalid"),
    ),
  "harness.research": value =>
    Effect.mapError(decodeHarnessResearchPayload(value), () =>
      error("invalid_input", "harness.research payload is invalid"),
    ),
}

export const REGISTERED_JOB_KINDS = Object.freeze(
  Object.keys(REGISTERED_JOB_PAYLOAD_DECODERS) as RegisteredJobKind[],
)

export const decodeJobSpec = (
  value: unknown,
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
    typeof value.kind !== "string" ||
    !REGISTERED_JOB_KINDS.includes(value.kind as RegisteredJobKind)
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

  let recurrence: ReviewDutyScanSpec["recurrence"]
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

  const kind = value.kind as RegisteredJobKind
  const decoder = REGISTERED_JOB_PAYLOAD_DECODERS[
    kind
  ] as PayloadDecoder<RegisteredJobKind>
  return Effect.map(
    decoder(value.payload),
    payload =>
      ({
        kind,
        payload,
        runAt: value.runAt as number,
        maxAttempts: value.maxAttempts as number,
        ...(recurrence ? { recurrence } : {}),
        ...(value.idempotencyKey !== undefined
          ? { idempotencyKey: value.idempotencyKey as string }
          : {}),
      }) as RegisteredJobSpec,
  )
}

export const decodeStoredJob = (
  value: unknown,
): Effect.Effect<Job, JobRuntimeError> => {
  if (!isRecord(value)) return invalid("stored job must be an object")
  const state = value.state
  if (
    state !== "scheduled" &&
    state !== "ready" &&
    state !== "retry_wait" &&
    state !== "leased" &&
    state !== "succeeded" &&
    state !== "failed" &&
    state !== "cancelled"
  ) {
    return invalid("stored job state is unknown")
  }
  const baseKeys = ["id", "spec", "state", "attempt", "createdAt", "updatedAt"]
  const stateKeys =
    state === "leased"
      ? ["workerId", "leaseToken", "leaseUntil", "cancelRequestedAt"]
      : state === "succeeded" || state === "failed" || state === "cancelled"
        ? ["finishedAt", "summary", "result"]
        : []
  if (!hasOnlyKeys(value, [...baseKeys, ...stateKeys]))
    return invalid("stored job contains unknown fields")
  if (
    !isSafeIdentifier(value.id, 128) ||
    !isBoundedInteger(value.attempt, 0, MAX_ATTEMPTS) ||
    !isTimestamp(value.createdAt) ||
    !isTimestamp(value.updatedAt) ||
    value.updatedAt < value.createdAt
  ) {
    return invalid("stored job base fields are malformed")
  }
  const id = value.id
  const attempt = value.attempt
  const createdAt = value.createdAt
  const updatedAt = value.updatedAt
  return Effect.flatMap(decodeJobSpec(value.spec), spec => {
    if (attempt > spec.maxAttempts)
      return invalid("stored job attempt exceeds its limit")
    const base = { id, spec, attempt, createdAt, updatedAt }
    if (state === "scheduled") {
      if (base.attempt !== 0 || spec.runAt <= base.updatedAt)
        return invalid("stored scheduled job fields are inconsistent")
      return Effect.succeed({ ...base, state })
    }
    if (state === "ready") {
      if (base.attempt !== 0 || spec.runAt > base.updatedAt)
        return invalid("stored ready job fields are inconsistent")
      return Effect.succeed({ ...base, state })
    }
    if (state === "retry_wait") {
      if (
        base.attempt < 1 ||
        base.attempt >= spec.maxAttempts ||
        spec.runAt < base.updatedAt
      )
        return invalid("stored retrying job fields are inconsistent")
      return Effect.succeed({ ...base, state })
    }
    if (state === "leased") {
      if (
        base.attempt < 1 ||
        spec.runAt > base.updatedAt ||
        !isSafeIdentifier(value.workerId, 128) ||
        !isSafeIdentifier(value.leaseToken, 128) ||
        !isTimestamp(value.leaseUntil) ||
        value.leaseUntil <= base.createdAt ||
        (value.cancelRequestedAt !== undefined &&
          (!isTimestamp(value.cancelRequestedAt) ||
            value.cancelRequestedAt < base.createdAt ||
            value.cancelRequestedAt > base.updatedAt))
      ) {
        return invalid("stored leased job fields are malformed")
      }
      const cancelRequestedAt = isTimestamp(value.cancelRequestedAt)
        ? value.cancelRequestedAt
        : undefined
      return Effect.succeed({
        ...base,
        state,
        workerId: value.workerId,
        leaseToken: value.leaseToken,
        leaseUntil: value.leaseUntil,
        ...(cancelRequestedAt !== undefined ? { cancelRequestedAt } : {}),
      })
    }
    if (state === "succeeded" || state === "failed" || state === "cancelled") {
      const cancelledBeforeClaim = state === "cancelled" && base.attempt === 0
      if (
        !isTimestamp(value.finishedAt) ||
        value.finishedAt !== base.updatedAt ||
        (state === "succeeded" && base.attempt < 1) ||
        (state === "failed" && base.attempt !== spec.maxAttempts) ||
        (cancelledBeforeClaim && value.summary !== undefined) ||
        (!cancelledBeforeClaim && spec.runAt > base.updatedAt)
      ) {
        return invalid("stored terminal job fields are malformed")
      }
      const finishedAt = value.finishedAt
      const summary = isSafeSummary(value.summary) ? value.summary : undefined
      if (value.result === undefined) {
        if (state === "succeeded") {
          if (
            spec.kind === "harness.review" ||
            spec.kind === "harness.research"
          )
            return invalid("successful harness job requires a typed result")
          if (summary === undefined)
            return invalid("stored terminal job fields are malformed")
          return Effect.succeed({ ...base, spec, state, finishedAt, summary })
        }
        if (state === "failed") {
          if (summary === undefined)
            return invalid("stored terminal job fields are malformed")
          return Effect.succeed({ ...base, state, finishedAt, summary })
        }
        if (!cancelledBeforeClaim && summary === undefined)
          return invalid("stored terminal job fields are malformed")
        return Effect.succeed({
          ...base,
          state,
          finishedAt,
          ...(summary !== undefined ? { summary } : {}),
        })
      }
      if (state !== "succeeded" && state !== "cancelled")
        return invalid("stored job result is not valid for this terminal state")
      if (
        !isRecord(value.result) ||
        !hasOnlyKeys(value.result, ["kind", "handoff"]) ||
        (value.result.kind !== "harness.review" &&
          value.result.kind !== "harness.research")
      )
        return invalid("stored harness result is malformed")
      if (summary === undefined)
        return invalid("stored terminal job fields are malformed")
      if (
        spec.kind === "harness.review" &&
        value.result.kind === "harness.review"
      ) {
        return Effect.flatMap(
          Effect.mapError(
            decodeHarnessReviewHandoff(value.result.handoff),
            () => error("invalid_input", "stored harness result is malformed"),
          ),
          handoff =>
            harnessHandoffMatchesAttempt(
              handoff,
              spec.payload,
              base.id,
              base.attempt,
            ) &&
            handoff.status !== "blocked" &&
            handoff.status !== "failed"
              ? Effect.succeed({
                  ...base,
                  spec,
                  state,
                  finishedAt,
                  summary,
                  result: { kind: "harness.review" as const, handoff },
                })
              : invalid("stored harness result does not match its job"),
        )
      }
      if (
        spec.kind === "harness.research" &&
        value.result.kind === "harness.research"
      ) {
        return Effect.flatMap(
          Effect.mapError(
            decodeHarnessResearchHandoff(value.result.handoff),
            () => error("invalid_input", "stored harness result is malformed"),
          ),
          handoff =>
            harnessResearchHandoffMatchesAttempt(
              handoff,
              spec.payload,
              base.id,
              base.attempt,
            )
              ? Effect.succeed({
                  ...base,
                  spec,
                  state,
                  finishedAt,
                  summary,
                  result: { kind: "harness.research" as const, handoff },
                })
              : invalid("stored harness result does not match its job"),
        )
      }
      return invalid("stored job result does not match its job kind")
    }
    return invalid("stored job state is inconsistent")
  })
}

export const createJob = (
  spec: RegisteredJobSpec,
  id: string,
  now: number,
): Effect.Effect<Job, JobRuntimeError> => {
  if (!isSafeIdentifier(id, 128))
    return invalid("job id must be bounded and safe")
  if (!isTimestamp(now)) return invalid("now must be a safe timestamp")
  return Effect.map(decodeJobSpec(spec), decoded => ({
    id,
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
    ...job,
    state: "leased",
    workerId,
    leaseToken,
    leaseUntil,
    attempt: job.attempt + 1,
    updatedAt: now,
  })
}

const currentLease = (
  job: Job,
  leaseToken: string,
  now: number,
): Effect.Effect<Extract<Job, { state: "leased" }>, JobRuntimeError> => {
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
    const finished = {
      id: leased.id,
      attempt: leased.attempt,
      createdAt: leased.createdAt,
      updatedAt: now,
      finishedAt: now,
      summary,
    }
    if (leased.spec.kind === "harness.review") {
      const spec = leased.spec
      if (
        result?.kind !== "harness.review" ||
        !harnessHandoffMatchesAttempt(
          result.handoff,
          spec.payload,
          leased.id,
          leased.attempt,
        )
      ) {
        return invalid("harness completion requires a matching typed result")
      }
      if (
        result.handoff.status === "blocked" ||
        result.handoff.status === "failed"
      )
        return invalidTransition(
          "unsuccessful harness handoff cannot complete a job",
        )
      return Effect.succeed({
        ...finished,
        spec,
        state:
          leased.cancelRequestedAt === undefined
            ? ("succeeded" as const)
            : ("cancelled" as const),
        result,
      })
    }
    if (leased.spec.kind === "harness.research") {
      const spec = leased.spec
      if (
        result?.kind !== "harness.research" ||
        !harnessResearchHandoffMatchesAttempt(
          result.handoff,
          spec.payload,
          leased.id,
          leased.attempt,
        )
      )
        return invalid("research completion requires a matching typed result")
      return Effect.succeed({
        ...finished,
        spec,
        state:
          leased.cancelRequestedAt === undefined
            ? ("succeeded" as const)
            : ("cancelled" as const),
        result,
      })
    }
    const spec = leased.spec
    if (result !== undefined)
      return invalid("job kind does not accept a typed harness result")
    return leased.cancelRequestedAt === undefined
      ? Effect.succeed({ ...finished, spec, state: "succeeded" as const })
      : Effect.succeed({ ...finished, spec, state: "cancelled" as const })
  })
}

const retryOrFail = (
  leased: Extract<Job, { state: "leased" }>,
  now: number,
  retryDelayMs: number,
  summary: string,
): Job => {
  if (leased.cancelRequestedAt !== undefined) {
    return {
      id: leased.id,
      spec: leased.spec,
      state: "cancelled",
      attempt: leased.attempt,
      createdAt: leased.createdAt,
      updatedAt: now,
      finishedAt: now,
      summary,
    }
  }
  if (leased.attempt >= leased.spec.maxAttempts) {
    return {
      id: leased.id,
      spec: leased.spec,
      state: "failed",
      attempt: leased.attempt,
      createdAt: leased.createdAt,
      updatedAt: now,
      finishedAt: now,
      summary,
    }
  }
  return {
    id: leased.id,
    spec: { ...leased.spec, runAt: now + retryDelayMs },
    state: "retry_wait",
    attempt: leased.attempt,
    createdAt: leased.createdAt,
    updatedAt: now,
  }
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
