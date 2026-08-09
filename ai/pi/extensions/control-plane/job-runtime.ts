import { homedir } from "node:os"
import { Data, Effect } from "effect"
import {
  decodeHarnessReviewHandoff,
  decodeHarnessReviewPayload,
  includesAny,
  requireHandoffMatchesAttempt,
  type HarnessReviewHandoff,
  type HarnessReviewPayload,
} from "./harness-protocol.ts"
import {
  canonicalPath,
  REVIEW_DUTY_PROFILES,
  type CanonicalPath,
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

/** Specs of the job kinds that finish without producing a typed result. */
export type ResultlessJobSpec = Exclude<RegisteredJobSpec, HarnessReviewSpec>

/** Handoff statuses that report a review the executor actually carried out. */
export type VerifiedHandoffStatus =
  | "clean"
  | "findings_fixed"
  | "findings_pending"

/** Handoff statuses that report an attempt which produced no review outcome. */
export type UnsuccessfulHandoffStatus = "blocked" | "failed"

export type VerifiedHarnessHandoff = HarnessReviewHandoff & {
  readonly status: VerifiedHandoffStatus
}

export type UnsuccessfulHarnessHandoff = HarnessReviewHandoff & {
  readonly status: UnsuccessfulHandoffStatus
}

export interface HarnessReviewResult {
  readonly kind: "harness.review"
  readonly handoff: HarnessReviewHandoff
}

export interface VerifiedHarnessReviewResult extends HarnessReviewResult {
  readonly handoff: VerifiedHarnessHandoff
}

export interface UnsuccessfulHarnessReviewResult extends HarnessReviewResult {
  readonly handoff: UnsuccessfulHarnessHandoff
}

export type RegisteredJobResult = HarnessReviewResult

interface JobIdentity {
  readonly id: string
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

export type Job =
  | (JobBase & { readonly state: "scheduled" | "ready" | "retry_wait" })
  | (JobBase & {
      readonly state: "leased"
      readonly workerId: string
      readonly leaseToken: string
      readonly leaseUntil: number
      readonly cancelRequestedAt?: number
    })
  | TerminalJob

/**
 * A job that has stopped, together with the evidence its attempt produced.
 * Which evidence a job can hold is decided by its kind and by how it stopped:
 * only a harness review hands back a typed handoff, only a verified handoff
 * can succeed, and only an unsuccessful one can accompany a failure. An
 * attempt abandoned before any handoff — a cancellation before the first
 * claim, or an expired lease — keeps none.
 */
export type TerminalJob =
  | (TerminalFields & {
      readonly spec: ResultlessJobSpec
      readonly state: "succeeded"
    })
  | (TerminalFields & {
      readonly spec: RegisteredJobSpec
      readonly state: "failed" | "cancelled"
    })
  | (TerminalFields & {
      readonly spec: HarnessReviewSpec
      readonly state: "succeeded"
      readonly result: VerifiedHarnessReviewResult
    })
  | (TerminalFields & {
      readonly spec: HarnessReviewSpec
      readonly state: "failed"
      readonly result: UnsuccessfulHarnessReviewResult
    })
  | (TerminalFields & {
      readonly spec: HarnessReviewSpec
      readonly state: "cancelled"
      readonly result: HarnessReviewResult
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

const invalidTransition = <A>(message: string): Effect.Effect<A, JobRuntimeError> =>
  Effect.fail(error("invalid_transition", message))

const staleLease = <A>(): Effect.Effect<A, JobRuntimeError> =>
  Effect.fail(error("stale_lease", "lease token is no longer current"))

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const isTimestamp = (value: unknown): value is number =>
  Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= MAX_TIMESTAMP

const isBoundedInteger = (
  value: unknown,
  minimum: number,
  maximum: number,
): value is number =>
  Number.isSafeInteger(value) && Number(value) >= minimum && Number(value) <= maximum

const hasOnlyKeys = (
  value: Readonly<Record<string, unknown>>,
  keys: readonly string[],
): boolean => Object.keys(value).every((key) => keys.includes(key))

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

const isVerifiedHandoff = (
  handoff: HarnessReviewHandoff,
): handoff is VerifiedHarnessHandoff =>
  handoff.status !== "blocked" && handoff.status !== "failed"

const isUnsuccessfulHandoff = (
  handoff: HarnessReviewHandoff,
): handoff is UnsuccessfulHarnessHandoff =>
  handoff.status === "blocked" || handoff.status === "failed"

const checkedAdd = (left: number, right: number): number | undefined => {
  const sum = left + right
  return isTimestamp(sum) ? sum : undefined
}

/**
 * Home directory the checkout locations registered for a harness payload are
 * resolved against. The control plane decodes payloads for the account it runs
 * as, so the home comes from the process: a payload cannot nominate the home
 * that decides whether the root it names is a registered checkout.
 */
export const controlPlaneHome = (): CanonicalPath | undefined =>
  canonicalPath(homedir())

type PayloadDecoder<Kind extends RegisteredJobKind> = (
  value: unknown,
) => Effect.Effect<RegisteredJobPayloads[Kind], JobRuntimeError>

const REGISTERED_JOB_PAYLOAD_DECODERS: {
  readonly [Kind in RegisteredJobKind]: PayloadDecoder<Kind>
} = {
  "review-duty.scan": (value) =>
    isRecord(value) &&
    hasOnlyKeys(value, ["profile"]) &&
    isReviewDutyProfile(value.profile)
      ? Effect.succeed({ profile: value.profile })
      : invalid("review-duty.scan requires a registered profile"),
  "harness.review": (value) => {
    const home = controlPlaneHome()
    if (home === undefined)
      return invalid("control plane home is not a canonical absolute path")
    return Effect.mapError(decodeHarnessReviewPayload(value, home), (failure) =>
      error("invalid_input", failure.message),
    )
  },
}

export const REGISTERED_JOB_KINDS = Object.freeze(
  Object.keys(REGISTERED_JOB_PAYLOAD_DECODERS) as RegisteredJobKind[],
)

const isReviewDutyProfile = (value: unknown): value is ReviewDutyProfile =>
  typeof value === "string" && includesAny(REVIEW_DUTY_PROFILES, value)

const isRegisteredJobKind = (value: unknown): value is RegisteredJobKind =>
  typeof value === "string" && includesAny(REGISTERED_JOB_KINDS, value)

/**
 * Pairs a decoded payload with the kind that selected its decoder. Each branch
 * narrows the discriminant to a single literal, so the compiler checks that a
 * payload and the kind it is stored under belong together instead of being
 * told to trust the pairing.
 */
const decodeRegisteredSpec = (
  kind: RegisteredJobKind,
  payload: unknown,
  schedule: JobSchedule,
): Effect.Effect<RegisteredJobSpec, JobRuntimeError> =>
  kind === "harness.review"
    ? Effect.map(REGISTERED_JOB_PAYLOAD_DECODERS[kind](payload), (decoded) => ({
        ...schedule,
        kind,
        payload: decoded,
      }))
    : Effect.map(REGISTERED_JOB_PAYLOAD_DECODERS[kind](payload), (decoded) => ({
        ...schedule,
        kind,
        payload: decoded,
      }))

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
    !isRegisteredJobKind(value.kind)
  ) {
    return invalid("job kind must be a registered bounded kind")
  }
  if (!isTimestamp(value.runAt)) return invalid("runAt must be a safe timestamp")
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
  return decodeRegisteredSpec(value.kind, value.payload, schedule)
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
  const baseKeys = [
    "id",
    "spec",
    "state",
    "attempt",
    "createdAt",
    "updatedAt",
  ]
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
  return Effect.flatMap(decodeJobSpec(value.spec), (spec) => {
    if (value.attempt > spec.maxAttempts)
      return invalid("stored job attempt exceeds its limit")
    const base: JobBase = {
      id: value.id as string,
      spec,
      attempt: value.attempt as number,
      createdAt: value.createdAt as number,
      updatedAt: value.updatedAt as number,
    }
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
        value.attempt < 1 ||
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
      return Effect.succeed({
        ...base,
        state,
        workerId: value.workerId,
        leaseToken: value.leaseToken,
        leaseUntil: value.leaseUntil,
        ...(value.cancelRequestedAt !== undefined
          ? { cancelRequestedAt: value.cancelRequestedAt }
          : {}),
      })
    }
    if (state === "succeeded" || state === "failed" || state === "cancelled") {
      const cancelledBeforeClaim = state === "cancelled" && base.attempt === 0
      if (
        !isTimestamp(value.finishedAt) ||
        value.finishedAt !== base.updatedAt ||
        (state === "succeeded" && base.attempt < 1) ||
        (state === "failed" && base.attempt !== spec.maxAttempts) ||
        ((state === "succeeded" || state === "failed" || base.attempt > 0) &&
          !isSafeSummary(value.summary)) ||
        (cancelledBeforeClaim && value.summary !== undefined) ||
        (!cancelledBeforeClaim && spec.runAt > base.updatedAt)
      ) {
        return invalid("stored terminal job fields are malformed")
      }
      const fields: TerminalFields = {
        id: base.id,
        attempt: base.attempt,
        createdAt: base.createdAt,
        updatedAt: base.updatedAt,
        finishedAt: value.finishedAt,
        ...(isSafeSummary(value.summary) ? { summary: value.summary } : {}),
      }
      if (value.result === undefined) {
        if (state !== "succeeded")
          return Effect.succeed({ ...fields, spec, state })
        return spec.kind === "harness.review"
          ? invalid("a succeeded harness review requires the handoff it produced")
          : Effect.succeed({ ...fields, spec, state })
      }
      if (spec.kind !== "harness.review")
        return invalid("stored job result is not valid for this job kind")
      return Effect.flatMap(
        storedHarnessHandoff(value.result, spec, base.id, base.attempt),
        (handoff) => {
          if (state === "cancelled") {
            const result: HarnessReviewResult = {
              kind: "harness.review",
              handoff,
            }
            return Effect.succeed({ ...fields, spec, state, result })
          }
          if (state === "succeeded") {
            return isVerifiedHandoff(handoff)
              ? Effect.succeed({
                  ...fields,
                  spec,
                  state,
                  result: { kind: "harness.review" as const, handoff },
                })
              : invalid("a succeeded harness review requires a verified handoff")
          }
          return isUnsuccessfulHandoff(handoff)
            ? Effect.succeed({
                ...fields,
                spec,
                state,
                result: { kind: "harness.review" as const, handoff },
              })
            : invalid("a failed harness review cannot carry a verified handoff")
        },
      )
    }
    return invalid("stored job state is inconsistent")
  })
}

export const createJob = (
  spec: RegisteredJobSpec,
  id: string,
  now: number,
): Effect.Effect<Job, JobRuntimeError> => {
  if (!isSafeIdentifier(id, 128)) return invalid("job id must be bounded and safe")
  if (!isTimestamp(now)) return invalid("now must be a safe timestamp")
  return Effect.map(decodeJobSpec(spec), (decoded) => ({
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
  if (leaseUntil === undefined) return invalid("lease expiry exceeds safe timestamp range")
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
): Effect.Effect<LeasedJob, JobRuntimeError> => {
  if (job.state !== "leased")
    return invalidTransition("job does not have an active lease")
  if (job.leaseToken !== leaseToken || job.leaseUntil <= now)
    return staleLease()
  return Effect.succeed(job)
}

/**
 * Publishes the outcome its lease holder reports. A harness review must hand
 * back the handoff it produced: the handoff is decoded here rather than
 * trusted from the caller, bound to the leased attempt, and stored with the
 * job, so a review that succeeded always carries the evidence for it.
 */
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
  if (!isSafeSummary(summary)) return invalid("summary must be bounded safe text")
  return Effect.flatMap(currentLease(job, leaseToken, now), (leased) => {
    const spec = leased.spec
    const fields = terminalFields(leased, now, summary)
    if (spec.kind !== "harness.review") {
      if (result !== undefined)
        return invalid("job kind does not accept a typed harness result")
      return Effect.succeed(
        leased.cancelRequestedAt === undefined
          ? { ...fields, spec, state: "succeeded" as const }
          : { ...fields, spec, state: "cancelled" as const },
      )
    }
    if (result === undefined)
      return invalid("harness completion requires the typed handoff it produced")
    return Effect.flatMap(
      boundHandoff(result.handoff, spec, leased.id, leased.attempt),
      (handoff) => {
        if (!isVerifiedHandoff(handoff))
          return invalidTransition(
            "unsuccessful harness handoff cannot complete a job",
          )
        const verified: VerifiedHarnessReviewResult = {
          kind: "harness.review",
          handoff,
        }
        return Effect.succeed(
          leased.cancelRequestedAt === undefined
            ? { ...fields, spec, state: "succeeded" as const, result: verified }
            : { ...fields, spec, state: "cancelled" as const, result: verified },
        )
      },
    )
  })
}

/**
 * Records an attempt its lease holder could not finish. A harness review may
 * hand back the blocked or failed handoff it produced, and that handoff is
 * decoded, bound to the attempt, and stored with the terminal job so the
 * reason survives past the attempt. A retry keeps no handoff: the next attempt
 * produces its own.
 */
export const failJob = (
  job: Job,
  leaseToken: string,
  now: number,
  retryDelayMs: number,
  summary: string,
  result?: RegisteredJobResult,
): Effect.Effect<Job, JobRuntimeError> => {
  if (!isTimestamp(now)) return invalid("now must be a safe timestamp")
  if (now < job.updatedAt)
    return invalid("now cannot precede the current job state")
  if (!isBoundedInteger(retryDelayMs, 0, MAX_RETRY_DELAY_MS))
    return invalid("retry delay must be bounded to seven days")
  if (checkedAdd(now, retryDelayMs) === undefined)
    return invalid("retry timestamp exceeds safe range")
  if (!isSafeSummary(summary)) return invalid("summary must be bounded safe text")
  return Effect.flatMap(currentLease(job, leaseToken, now), (leased) => {
    if (result === undefined)
      return Effect.succeed(
        retryOrFail(leased, now, retryDelayMs, summary, undefined),
      )
    const spec = leased.spec
    if (spec.kind !== "harness.review")
      return invalid("job kind does not accept a typed harness result")
    return Effect.flatMap(
      boundHandoff(result.handoff, spec, leased.id, leased.attempt),
      (handoff) =>
        isUnsuccessfulHandoff(handoff)
          ? Effect.succeed(
              retryOrFail(leased, now, retryDelayMs, summary, {
                kind: "harness.review",
                handoff,
              }),
            )
          : invalidTransition(
              "a verified harness handoff completes a job instead of failing it",
            ),
    )
  })
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
    return Effect.succeed({
      ...job,
      cancelRequestedAt: job.cancelRequestedAt ?? now,
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
    retryOrFail(job, now, retryDelayMs, "worker lease expired", undefined),
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
  result: UnsuccessfulHarnessReviewResult | undefined,
): Job => {
  const spec = leased.spec
  if (
    leased.cancelRequestedAt === undefined &&
    leased.attempt < spec.maxAttempts
  ) {
    return {
      id: leased.id,
      spec: { ...spec, runAt: now + retryDelayMs },
      state: "retry_wait",
      attempt: leased.attempt,
      createdAt: leased.createdAt,
      updatedAt: now,
    }
  }
  const fields = terminalFields(leased, now, summary)
  if (spec.kind !== "harness.review" || result === undefined) {
    const state = leased.cancelRequestedAt === undefined ? "failed" : "cancelled"
    return { ...fields, spec, state }
  }
  return leased.cancelRequestedAt === undefined
    ? { ...fields, spec, state: "failed" as const, result }
    : { ...fields, spec, state: "cancelled" as const, result }
}

/**
 * Decodes an untrusted handoff and binds it to the attempt it claims to
 * answer, so no handoff reaches a job without passing the same two checks.
 */
const boundHandoff = (
  value: unknown,
  spec: HarnessReviewSpec,
  jobId: string,
  attempt: number,
): Effect.Effect<HarnessReviewHandoff, JobRuntimeError> =>
  Effect.flatMap(
    Effect.mapError(decodeHarnessReviewHandoff(value), (failure) =>
      error("invalid_input", failure.message),
    ),
    (handoff) =>
      Effect.map(
        Effect.mapError(
          requireHandoffMatchesAttempt(handoff, spec.payload, jobId, attempt),
          (failure) => error("invalid_input", failure.message),
        ),
        () => handoff,
      ),
  )

const storedHarnessHandoff = (
  value: unknown,
  spec: HarnessReviewSpec,
  jobId: string,
  attempt: number,
): Effect.Effect<HarnessReviewHandoff, JobRuntimeError> => {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["kind", "handoff"]) ||
    value.kind !== "harness.review"
  ) {
    return invalid("stored harness result is malformed")
  }
  return boundHandoff(value.handoff, spec, jobId, attempt)
}
