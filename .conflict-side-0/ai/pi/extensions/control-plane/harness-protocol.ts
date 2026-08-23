import { Data, Effect } from "effect"
import {
  automaticRepositoryForProfile,
  canonicalPath,
  repositoryAllowedForProfile,
  repositoryRootIsRegisteredUnder,
  repositorySlug,
  REVIEW_DUTY_PROFILES,
  type CanonicalPath,
  type ReviewDutyProfile,
} from "./review-duty-profile.ts"

export const HARNESS_LANES = ["claude-code-max"] as const

export type HarnessLane = (typeof HARNESS_LANES)[number]
export type ReviewKind = "own" | "assigned" | "auto"

/**
 * A job identifier bounded by the harness protocol. Branding keeps it from
 * being passed where a directory, a lease token, or a summary is expected, and
 * the reverse: they are all strings, and this one decides which attempt a
 * handoff answers and where the process runs.
 */
export type JobId = string & { readonly __brand: "JobId" }

/**
 * A commit identifier in the only form the protocol accepts. An input head and
 * an output head are the same shape and are compared against each other, so
 * both carry the type that only `toCommitSha` produces.
 */
export type CommitSha = string & { readonly __brand: "CommitSha" }

export const toJobId = (value: string): JobId | undefined =>
  SAFE_JOB_ID.test(value) ? (value as JobId) : undefined

export const toCommitSha = (value: string): CommitSha | undefined =>
  HEAD_SHA.test(value) ? (value as CommitSha) : undefined

interface HarnessReviewIdentity {
  readonly profile: ReviewDutyProfile
  readonly repository: string
  readonly pullRequest: number
  readonly kind: ReviewKind
  readonly inputHeadSha: CommitSha
  readonly repositoryRoot: CanonicalPath
}

export type HarnessReviewPayload =
  | (HarnessReviewIdentity & {
      readonly lane: "claude-code-max"
      readonly kind: "assigned"
      readonly task: "review-pr"
      readonly isolation: "read-only"
    })
  | (HarnessReviewIdentity & {
      readonly lane: "claude-code-max"
      readonly kind: "own" | "auto"
      readonly task: "review-loop"
      readonly isolation: "approved-worktree"
    })

export interface HarnessReviewHandoff {
  readonly protocolVersion: 1
  readonly jobId: JobId
  readonly attempt: number
  readonly lane: HarnessLane
  readonly repository: string
  readonly pullRequest: number
  readonly inputHeadSha: CommitSha
  readonly outputHeadSha: CommitSha
  readonly status:
    | "clean"
    | "findings_fixed"
    | "findings_pending"
    | "blocked"
    | "failed"
  readonly assessment: string
  readonly evidence: readonly string[]
  readonly verifier:
    | "fable-clean"
    | "fable-rejected"
    | "unavailable"
    | "not-applicable"
  readonly executorProvenance: "subscription-verified"
}

export class HarnessProtocolError extends Data.TaggedError(
  "HarnessProtocolError",
)<{
  readonly code: "invalid_input"
  readonly message: string
}> {}

const invalid = <A>(message: string): Effect.Effect<A, HarnessProtocolError> =>
  Effect.fail(new HarnessProtocolError({ code: "invalid_input", message }))

/**
 * Membership test that widens the candidate table instead of narrowing the
 * probed value, so no call site has to claim an arbitrary string is already
 * one of the registered literals.
 */
export const includesAny = (
  candidates: readonly string[],
  value: string,
): boolean => candidates.includes(value)

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const isOneOf = <T extends string>(
  candidates: readonly T[],
  value: unknown,
): value is T => typeof value === "string" && includesAny(candidates, value)

const hasExactKeys = (
  value: Readonly<Record<string, unknown>>,
  expected: readonly string[],
): boolean =>
  Object.keys(value).length === expected.length &&
  Object.keys(value).every(key => expected.includes(key))

const HEAD_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u
const MAX_PULL_REQUEST = 2_147_483_647
const COMMON_KEYS = [
  "lane",
  "task",
  "profile",
  "repository",
  "pullRequest",
  "kind",
  "inputHeadSha",
  "repositoryRoot",
  "isolation",
] as const

const CREDENTIAL_SEGMENTS = [".ssh", ".gnupg", ".aws"] as const

/**
 * Whether any segment of a path names a credential store. Segments are lowered
 * before they are compared because the account's filesystem is
 * case-insensitive: `.SSH` and `.ssh` are the same directory, so a differently
 * cased segment must not read as a different one.
 */
export const isCredentialBearingPath = (path: string): boolean =>
  path
    .split("/")
    .filter((segment) => segment.length > 0)
    .map((segment) => segment.toLowerCase())
    .some(
      (segment) =>
        includesAny(CREDENTIAL_SEGMENTS, segment) ||
        segment.startsWith(".env"),
    )

const REVIEW_KINDS = ["own", "assigned", "auto"] as const

const decodeIdentity = (
  value: Readonly<Record<string, unknown>>,
  home: CanonicalPath,
): Effect.Effect<HarnessReviewIdentity, HarnessProtocolError> => {
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
    !isOneOf(REVIEW_DUTY_PROFILES, value.profile) ||
    repository === undefined ||
    !Number.isSafeInteger(value.pullRequest) ||
    Number(value.pullRequest) < 1 ||
    Number(value.pullRequest) > MAX_PULL_REQUEST ||
    !isOneOf(REVIEW_KINDS, value.kind) ||
    inputHeadSha === undefined ||
    repositoryRoot === undefined
  ) {
    return invalid("harness review identity is malformed")
  }
  if (!repositoryAllowedForProfile(value.profile, repository))
    return invalid("repository is outside the selected review profile")
  if (
    isCredentialBearingPath(repositoryRoot) ||
    !repositoryRootIsRegisteredUnder(home)(
      value.profile,
      repository,
      repositoryRoot,
    )
  ) {
    return invalid(
      "repository root is not a registered checkout of the declared repository",
    )
  }
  if (
    value.kind === "auto" &&
    automaticRepositoryForProfile(value.profile) !== repository
  ) {
    return invalid("automatic review is not registered for this repository")
  }
  return Effect.succeed({
    profile: value.profile,
    repository,
    pullRequest: Number(value.pullRequest),
    kind: value.kind,
    inputHeadSha,
    repositoryRoot,
  })
}

const SAFE_JOB_ID = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/u
const SAFE_EVIDENCE = /^(?:check|commit|head|pr|review|test|workflow):[A-Za-z0-9][A-Za-z0-9:./_#@-]{0,220}$/u
const UNSAFE_CONTROL = /[\u0000-\u001f\u007f]/u
const HANDOFF_KEYS = [
  "protocolVersion",
  "jobId",
  "attempt",
  "lane",
  "repository",
  "pullRequest",
  "inputHeadSha",
  "outputHeadSha",
  "status",
  "assessment",
  "evidence",
  "verifier",
  "executorProvenance",
] as const
const HANDOFF_STATUSES = [
  "clean",
  "findings_fixed",
  "findings_pending",
  "blocked",
  "failed",
] as const
const HANDOFF_VERIFIERS = [
  "fable-clean",
  "fable-rejected",
  "unavailable",
  "not-applicable",
] as const

/**
 * Decodes an untrusted harness review payload against the checkouts
 * registered under `home`. The home directory is a parameter because the
 * registered checkout locations are home-relative: a caller states which home
 * a payload is being decoded for, and no path outside it decodes.
 */
export const decodeHarnessReviewPayload = (
  value: unknown,
  home: CanonicalPath,
): Effect.Effect<HarnessReviewPayload, HarnessProtocolError> => {
  if (!isRecord(value))
    return invalid("harness review payload must be an object")
  if (value.lane === "claude-code-max") {
    if (!hasExactKeys(value, COMMON_KEYS))
      return invalid("Claude review payload contains unknown fields")
    return Effect.flatMap(decodeIdentity(value, home), (identity) => {
      if (identity.kind === "assigned") {
        if (value.task !== "review-pr" || value.isolation !== "read-only")
          return invalid(
            "Claude review task and isolation do not match its kind",
          )
        return Effect.succeed<HarnessReviewPayload>({
          ...identity,
          kind: identity.kind,
          lane: "claude-code-max",
          task: "review-pr",
          isolation: "read-only",
        })
      }
      if (
        value.task !== "review-loop" ||
        value.isolation !== "approved-worktree"
      )
        return invalid("Claude review task and isolation do not match its kind")
      return Effect.succeed<HarnessReviewPayload>({
        ...identity,
        kind: identity.kind,
        lane: "claude-code-max",
        task: "review-loop",
        isolation: "approved-worktree",
      })
    })
  }
  if (value.lane === "cursor-subscription") {
    if (!hasExactKeys(value, [...COMMON_KEYS, "model"]))
      return invalid("Cursor review payload contains unknown fields")
    return Effect.flatMap(decodeIdentity(value, home), (identity) => {
      if (
        value.task !== "review-probe" ||
        value.isolation !== "read-only" ||
        identity.kind === "auto" ||
        !isOneOf(CURSOR_REVIEW_MODELS, value.model)
      ) {
        return invalid("Cursor review lane must be a registered read-only probe")
      }
      return Effect.succeed<HarnessReviewPayload>({
        ...identity,
        kind: identity.kind,
        lane: "cursor-subscription",
        task: "review-probe",
        model: value.model,
        isolation: "read-only",
      })
    })
  }
  return invalid("harness lane is not registered")
}

export const decodeHarnessReviewHandoff = (
  value: unknown,
): Effect.Effect<HarnessReviewHandoff, HarnessProtocolError> => {
  if (!isRecord(value) || !hasExactKeys(value, HANDOFF_KEYS))
    return invalid("harness handoff must contain exact versioned fields")
  const jobId =
    typeof value.jobId === "string" ? toJobId(value.jobId) : undefined
  const inputHeadSha =
    typeof value.inputHeadSha === "string"
      ? toCommitSha(value.inputHeadSha)
      : undefined
  const outputHeadSha =
    typeof value.outputHeadSha === "string"
      ? toCommitSha(value.outputHeadSha)
      : undefined
  const evidence = Array.isArray(value.evidence)
    ? value.evidence.filter(
        (item): item is string =>
          typeof item === "string" && SAFE_EVIDENCE.test(item),
      )
    : []
  if (
    value.protocolVersion !== 1 ||
    jobId === undefined ||
    !Number.isSafeInteger(value.attempt) ||
    Number(value.attempt) < 1 ||
    Number(value.attempt) > 100 ||
    !isOneOf(HARNESS_LANES, value.lane) ||
    typeof value.repository !== "string" ||
    repositorySlug(value.repository) === undefined ||
    !Number.isSafeInteger(value.pullRequest) ||
    Number(value.pullRequest) < 1 ||
    Number(value.pullRequest) > MAX_PULL_REQUEST ||
    inputHeadSha === undefined ||
    outputHeadSha === undefined ||
    !isOneOf(HANDOFF_STATUSES, value.status) ||
    typeof value.assessment !== "string" ||
    value.assessment.trim().length < 1 ||
    value.assessment.length > 500 ||
    UNSAFE_CONTROL.test(value.assessment) ||
    !Array.isArray(value.evidence) ||
    value.evidence.length > 16 ||
    evidence.length !== value.evidence.length ||
    ((value.status === "clean" ||
      value.status === "findings_fixed" ||
      value.status === "findings_pending") &&
      evidence.length < 1) ||
    !isOneOf(HANDOFF_VERIFIERS, value.verifier) ||
    value.executorProvenance !== "subscription-verified"
  ) {
    return invalid("harness handoff fields are malformed")
  }
  if (evidence.some(isCredentialBearingPath)) {
    return invalid(
      "harness handoff evidence must not name a protected or credential path",
    )
  }
  if (value.verifier === "fable-clean" && evidence.length < 1)
    return invalid("a Fable-verified handoff must carry evidence identifiers")
  if (
    value.status === "findings_fixed" &&
    !evidence.includes(`commit:${outputHeadSha}`)
  ) {
    return invalid("a fixed handoff must cite the commit it produced")
  }
  return Effect.succeed({
    protocolVersion: 1,
    jobId,
    attempt: Number(value.attempt),
    lane: value.lane,
    repository: value.repository,
    pullRequest: Number(value.pullRequest),
    inputHeadSha,
    outputHeadSha,
    status: value.status,
    assessment: value.assessment,
    evidence,
    verifier: value.verifier,
    executorProvenance: "subscription-verified",
  })
}

export type HarnessHandoffMismatch =
  | "job-id"
  | "attempt"
  | "lane"
  | "repository"
  | "pull-request"
  | "input-head"
  | "read-only-mutation"
  | "unchanged-head"
  | "moved-head"
  | "unverified"

export type HarnessHandoffAttemptMatch =
  | { readonly outcome: "matched" }
  | {
      readonly outcome: "mismatched"
      readonly mismatch: HarnessHandoffMismatch
    }

/**
 * Binds an untrusted executor handoff to the attempt it claims to answer,
 * naming the first invariant it violates so callers report which binding
 * failed instead of a single undiagnosable rejection.
 */
export const harnessHandoffAttemptMatch = (
  handoff: HarnessReviewHandoff,
  payload: HarnessReviewPayload,
  jobId: JobId,
  attempt: number,
): HarnessHandoffAttemptMatch => {
  const mismatch = handoffMismatch(handoff, payload, jobId, attempt)
  return mismatch === undefined
    ? { outcome: "matched" }
    : { outcome: "mismatched", mismatch }
}

export const requireHandoffMatchesAttempt = (
  handoff: HarnessReviewHandoff,
  payload: HarnessReviewPayload,
  jobId: JobId,
  attempt: number,
): Effect.Effect<void, HarnessProtocolError> => {
  const match = harnessHandoffAttemptMatch(handoff, payload, jobId, attempt)
  return match.outcome === "matched"
    ? Effect.void
    : invalid(HANDOFF_MISMATCH_MESSAGES[match.mismatch])
}

const HANDOFF_MISMATCH_MESSAGES: Readonly<
  Record<HarnessHandoffMismatch, string>
> = {
  "job-id": "handoff job identifier does not match the leased job",
  attempt: "handoff attempt does not match the leased attempt",
  lane: "handoff lane does not match the leased payload",
  repository: "handoff repository does not match the leased payload",
  "pull-request": "handoff pull request does not match the leased payload",
  "input-head": "handoff input head does not match the leased payload",
  "read-only-mutation":
    "read-only isolation forbids a moved head or a fixed-findings status",
  "unchanged-head":
    "fixed findings require an output head distinct from the input head",
  "moved-head":
    "only fixed findings may hand back an output head that moved",
  unverified: "a verified terminal status requires a clean Fable verification",
}

const handoffMismatch = (
  handoff: HarnessReviewHandoff,
  payload: HarnessReviewPayload,
  jobId: JobId,
  attempt: number,
): HarnessHandoffMismatch | undefined => {
  if (handoff.jobId !== jobId) return "job-id"
  if (handoff.attempt !== attempt) return "attempt"
  if (handoff.lane !== payload.lane) return "lane"
  if (handoff.repository !== payload.repository) return "repository"
  if (handoff.pullRequest !== payload.pullRequest) return "pull-request"
  if (handoff.inputHeadSha !== payload.inputHeadSha) return "input-head"
  if (
    payload.isolation === "read-only" &&
    (handoff.outputHeadSha !== payload.inputHeadSha ||
      handoff.status === "findings_fixed")
  ) {
    return "read-only-mutation"
  }
  if (handoff.status === "findings_fixed") {
    if (handoff.outputHeadSha === handoff.inputHeadSha) return "unchanged-head"
  } else if (handoff.outputHeadSha !== handoff.inputHeadSha) {
    return "moved-head"
  }
  if (isVerifiedStatus(handoff.status) && handoff.verifier !== "fable-clean")
    return "unverified"
  return undefined
}

const isVerifiedStatus = (status: HarnessReviewHandoff["status"]): boolean =>
  status === "clean" ||
  status === "findings_fixed" ||
  status === "findings_pending"
