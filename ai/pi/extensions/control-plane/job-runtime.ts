import { Data, Effect } from "effect"
import {
  CURSOR_REVIEW_MODELS,
  decodeHarnessReviewHandoff,
  decodeHarnessReviewPayload,
  includesAny,
  isCredentialBearingPath,
  requireHandoffMatchesAttempt,
  toCommitSha,
  toJobId,
  type CommitSha,
  type HarnessProtocolError,
  type HarnessReviewHandoff,
  type HarnessReviewPayload,
  type JobId,
  type ReviewKind,
} from "./harness-protocol.ts"
import {
  canonicalPath,
  repositorySlug,
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
 * The payload decoders one boundary applies. The enqueue boundary and the
 * stored-job boundary ask different questions of the same payload, so each
 * supplies its own table and neither can be reached with the other's rules.
 */
type JobPayloadDecoders = {
  readonly [Kind in RegisteredJobKind]: (
    value: unknown,
  ) => Effect.Effect<RegisteredJobPayloads[Kind], JobRuntimeError>
}

const asRuntimeError = <A>(
  effect: Effect.Effect<A, HarnessProtocolError>,
): Effect.Effect<A, JobRuntimeError> =>
  Effect.mapError(effect, (failure) => error("invalid_input", failure.message))

const decodeReviewDutyScanPayload = (
  value: unknown,
): Effect.Effect<RegisteredJobPayloads["review-duty.scan"], JobRuntimeError> =>
  isRecord(value) &&
  hasOnlyKeys(value, ["profile"]) &&
  isReviewDutyProfile(value.profile)
    ? Effect.succeed({ profile: value.profile })
    : invalid("review-duty.scan requires a registered profile")

/**
 * Decoders for a payload arriving at the untrusted enqueue boundary. A harness
 * payload is bound here to a checkout registered under `home`, which the
 * caller that read the environment states rather than this module discovering
 * it: a payload cannot nominate the home that decides whether the root it
 * names is a registered checkout.
 */
const enqueuePayloadDecoders = (home: CanonicalPath): JobPayloadDecoders => ({
  "review-duty.scan": decodeReviewDutyScanPayload,
  "harness.review": (value) =>
    asRuntimeError(decodeHarnessReviewPayload(value, home)),
})

/**
 * Decoders for a payload read back out of the store. A stored payload was
 * already bound to a registered checkout when it was admitted, so re-hydrating
 * it checks only the form it must still have and never re-decides containment.
 * Containment depends on the home the service runs as and on the registered
 * checkout locations; deciding it again on every read would turn a relaunch
 * under another home, or an edited location table, into a store full of
 * unreadable jobs instead of a rejected enqueue.
 */
const STORED_PAYLOAD_DECODERS: JobPayloadDecoders = {
  "review-duty.scan": decodeReviewDutyScanPayload,
  "harness.review": (value) => decodeStoredHarnessPayload(value),
}

export const REGISTERED_JOB_KINDS = Object.freeze(
  Object.keys(STORED_PAYLOAD_DECODERS) as RegisteredJobKind[],
)

const isOneOf = <T extends string>(
  candidates: readonly T[],
  value: unknown,
): value is T => typeof value === "string" && includesAny(candidates, value)

const isReviewDutyProfile = (value: unknown): value is ReviewDutyProfile =>
  isOneOf(REVIEW_DUTY_PROFILES, value)

const isRegisteredJobKind = (value: unknown): value is RegisteredJobKind =>
  isOneOf(REGISTERED_JOB_KINDS, value)

const MAX_PULL_REQUEST = 2_147_483_647
const REVIEW_KINDS: readonly ReviewKind[] = ["own", "assigned", "auto"]
const HARNESS_PAYLOAD_KEYS = [
  "lane",
  "task",
  "profile",
  "repository",
  "pullRequest",
  "kind",
  "inputHeadSha",
  "repositoryRoot",
  "isolation",
]

interface StoredHarnessIdentity {
  readonly profile: ReviewDutyProfile
  readonly repository: string
  readonly pullRequest: number
  readonly kind: ReviewKind
  readonly inputHeadSha: CommitSha
  readonly repositoryRoot: CanonicalPath
}

/**
 * Re-hydrates a stored harness payload from its form alone: the registered
 * lane, task, kind and isolation it must pair, a slug-shaped repository, a
 * bounded pull request, a canonical root that names no credential store, and a
 * head in the one accepted commit form. Whether that root is a registered
 * checkout was decided when the payload was enqueued and is not asked again.
 */
const decodeStoredHarnessPayload = (
  value: unknown,
): Effect.Effect<HarnessReviewPayload, JobRuntimeError> => {
  if (!isRecord(value))
    return invalid("stored harness payload must be an object")
  const identity = storedHarnessIdentity(value)
  if (identity === undefined)
    return invalid("stored harness payload identity is malformed")
  if (value.lane === "claude-code-max") {
    if (!hasOnlyKeys(value, HARNESS_PAYLOAD_KEYS))
      return invalid("stored Claude review payload contains unknown fields")
    if (identity.kind === "assigned") {
      return value.task === "review-pr" && value.isolation === "read-only"
        ? Effect.succeed<HarnessReviewPayload>({
            ...identity,
            kind: identity.kind,
            lane: "claude-code-max",
            task: "review-pr",
            isolation: "read-only",
          })
        : invalid("stored Claude review task does not match its kind")
    }
    return value.task === "review-loop" &&
      value.isolation === "approved-worktree"
      ? Effect.succeed<HarnessReviewPayload>({
          ...identity,
          kind: identity.kind,
          lane: "claude-code-max",
          task: "review-loop",
          isolation: "approved-worktree",
        })
      : invalid("stored Claude review task does not match its kind")
  }
  if (value.lane === "cursor-subscription") {
    if (!hasOnlyKeys(value, [...HARNESS_PAYLOAD_KEYS, "model"]))
      return invalid("stored Cursor review payload contains unknown fields")
    return value.task === "review-probe" &&
      value.isolation === "read-only" &&
      identity.kind !== "auto" &&
      isOneOf(CURSOR_REVIEW_MODELS, value.model)
      ? Effect.succeed<HarnessReviewPayload>({
          ...identity,
          kind: identity.kind,
          lane: "cursor-subscription",
          task: "review-probe",
          model: value.model,
          isolation: "read-only",
        })
      : invalid("stored Cursor review lane is not a registered read-only probe")
  }
  return invalid("stored harness lane is not registered")
}

const storedHarnessIdentity = (
  value: Readonly<Record<string, unknown>>,
): StoredHarnessIdentity | undefined => {
  const repository =
    typeof value.repository === "string"
      ? repositorySlug(value.repository)
      : undefined
  const repositoryRoot =
    typeof value.repositoryRoot === "string"
      ? canonicalPath(value.repositoryRoot)
      : undefined
  const inputHeadSha =
    typeof value.inputHeadSha === "string"
      ? toCommitSha(value.inputHeadSha)
      : undefined
  if (
    !isReviewDutyProfile(value.profile) ||
    !isOneOf(REVIEW_KINDS, value.kind) ||
    !isBoundedInteger(value.pullRequest, 1, MAX_PULL_REQUEST) ||
    repository === undefined ||
    repositoryRoot === undefined ||
    isCredentialBearingPath(repositoryRoot) ||
    inputHeadSha === undefined
  ) {
    return undefined
  }
  return {
    profile: value.profile,
    repository,
    pullRequest: value.pullRequest,
    kind: value.kind,
    inputHeadSha,
    repositoryRoot,
  }
}

/**
 * Pairs a decoded payload with the kind that selected its decoder. Both
 * branches read alike on purpose: indexing the decoder table with an
 * un-narrowed kind yields a payload that could belong to any kind, and the
 * resulting pair is not a `RegisteredJobSpec`. Narrowing the discriminant to a
 * single literal first is what makes the compiler check that a payload and the
 * kind it is stored under belong together.
 */
const decodeRegisteredSpec = (
  kind: RegisteredJobKind,
  payload: unknown,
  schedule: JobSchedule,
  decoders: JobPayloadDecoders,
): Effect.Effect<RegisteredJobSpec, JobRuntimeError> =>
  kind === "harness.review"
    ? Effect.map(decoders[kind](payload), (decoded) => ({
        ...schedule,
        kind,
        payload: decoded,
      }))
    : Effect.map(decoders[kind](payload), (decoded) => ({
        ...schedule,
        kind,
        payload: decoded,
      }))

/**
 * Decodes a job spec offered to the enqueue boundary, binding any harness
 * payload to a checkout registered under `home`.
 */
export const decodeJobSpec = (
  value: unknown,
  home: CanonicalPath,
): Effect.Effect<RegisteredJobSpec, JobRuntimeError> =>
  decodeSpecWith(value, enqueuePayloadDecoders(home))

/** Decodes a job spec read back out of the store, by form only. */
const decodeStoredJobSpec = (
  value: unknown,
): Effect.Effect<RegisteredJobSpec, JobRuntimeError> =>
  decodeSpecWith(value, STORED_PAYLOAD_DECODERS)

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
  return decodeRegisteredSpec(value.kind, value.payload, schedule, decoders)
}

type JobState = Job["state"]

const BASE_JOB_KEYS = ["id", "spec", "state", "attempt", "createdAt", "updatedAt"]
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
  return Effect.flatMap(decodeStoredJobSpec(value.spec), (spec) => {
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
  if (value.result === undefined) {
    if (state !== "succeeded") return Effect.succeed({ ...fields, spec, state })
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
        const result: HarnessReviewResult = { kind: "harness.review", handoff }
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
  home: CanonicalPath,
): Effect.Effect<Job, JobRuntimeError> => {
  const jobId = toJobId(id)
  if (jobId === undefined) return invalid("job id must be bounded and safe")
  if (!isTimestamp(now)) return invalid("now must be a safe timestamp")
  return Effect.map(decodeJobSpec(spec, home), (decoded) => ({
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
 * reason survives past the attempt. A retry keeps the summary of the attempt
 * that failed rather than the handoff itself: the next attempt produces its
 * own evidence, but why the last one stopped stays readable.
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
      lastAttemptSummary: summary,
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
  jobId: JobId,
  attempt: number,
): Effect.Effect<HarnessReviewHandoff, JobRuntimeError> =>
  Effect.flatMap(
    asRuntimeError(decodeHarnessReviewHandoff(value)),
    (handoff) =>
      Effect.map(
        asRuntimeError(
          requireHandoffMatchesAttempt(handoff, spec.payload, jobId, attempt),
        ),
        () => handoff,
      ),
  )

const storedHarnessHandoff = (
  value: unknown,
  spec: HarnessReviewSpec,
  jobId: JobId,
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
