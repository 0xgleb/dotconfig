import { Data, Effect } from "effect"
import {
  repositoryAutomaticForProfile,
  repositoryAllowedForProfile,
  REVIEW_DUTY_PROFILES,
  type ReviewDutyProfile,
} from "./review-duty-profile.ts"

export const HARNESS_LANES = ["claude-code-max"] as const

export type HarnessLane = (typeof HARNESS_LANES)[number]
export type ReviewKind = "own" | "assigned" | "auto"

interface HarnessReviewIdentity {
  readonly profile: ReviewDutyProfile
  readonly repository: string
  readonly pullRequest: number
  readonly kind: ReviewKind
  readonly inputHeadSha: string
  readonly repositoryRoot: string
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
  readonly jobId: string
  readonly attempt: number
  readonly lane: HarnessLane
  readonly repository: string
  readonly pullRequest: number
  readonly inputHeadSha: string
  readonly outputHeadSha: string
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

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const isOneOf = <T extends string>(
  candidates: readonly T[],
  value: unknown,
): value is T =>
  typeof value === "string" && (candidates as readonly string[]).includes(value)

const hasExactKeys = (
  value: Readonly<Record<string, unknown>>,
  expected: readonly string[],
): boolean =>
  Object.keys(value).length === expected.length &&
  Object.keys(value).every(key => expected.includes(key))

const SAFE_REPOSITORY =
  /^[a-z0-9][a-z0-9._-]{0,63}\/[a-z0-9][a-z0-9._-]{0,99}$/u
const HEAD_SHA = /^[0-9a-f]{40,64}$/u
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

const isCanonicalAbsolutePath = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length >= 1 &&
  value.length <= 1_024 &&
  value.startsWith("/") &&
  (value === "/" ||
    (!value.endsWith("/") &&
      value
        .split("/")
        .slice(1)
        .every(
          segment => segment.length > 0 && segment !== "." && segment !== "..",
        )))

const CREDENTIAL_SEGMENTS = [".ssh", ".gnupg", ".aws"] as const

export const isCredentialBearingPath = (path: string): boolean =>
  path
    .split("/")
    .filter(segment => segment.length > 0)
    .some(
      segment =>
        CREDENTIAL_SEGMENTS.includes(
          segment as (typeof CREDENTIAL_SEGMENTS)[number],
        ) || segment.startsWith(".env"),
    )

const rootMatchesRepository = (identity: {
  readonly root: string
  readonly repository: string
}): boolean => {
  const name = identity.repository.split("/").at(1)
  if (name === undefined) return false
  const segments = identity.root
    .split("/")
    .filter(segment => segment.length > 0)
  return segments.some(
    (segment, index) =>
      segment === name &&
      (index === segments.length - 1 || segments[index + 1] === ".worktrees"),
  )
}

const REVIEW_KINDS = ["own", "assigned", "auto"] as const

const decodeIdentity = (
  value: Readonly<Record<string, unknown>>,
): Effect.Effect<HarnessReviewIdentity, HarnessProtocolError> => {
  if (
    !isOneOf(REVIEW_DUTY_PROFILES, value.profile) ||
    typeof value.repository !== "string" ||
    !SAFE_REPOSITORY.test(value.repository) ||
    !Number.isSafeInteger(value.pullRequest) ||
    Number(value.pullRequest) < 1 ||
    Number(value.pullRequest) > MAX_PULL_REQUEST ||
    !isOneOf(REVIEW_KINDS, value.kind) ||
    typeof value.inputHeadSha !== "string" ||
    !HEAD_SHA.test(value.inputHeadSha) ||
    !isCanonicalAbsolutePath(value.repositoryRoot)
  ) {
    return invalid("harness review identity is malformed")
  }
  if (
    isCredentialBearingPath(value.repositoryRoot) ||
    !rootMatchesRepository({
      root: value.repositoryRoot,
      repository: value.repository,
    })
  ) {
    return invalid("repository root is not bound to the declared repository")
  }
  if (!repositoryAllowedForProfile(value.profile, value.repository))
    return invalid("repository is outside the selected review profile")
  if (
    value.kind === "auto" &&
    !repositoryAutomaticForProfile(value.profile, value.repository)
  ) {
    return invalid("automatic review is not registered for this repository")
  }
  return Effect.succeed({
    profile: value.profile,
    repository: value.repository,
    pullRequest: Number(value.pullRequest),
    kind: value.kind,
    inputHeadSha: value.inputHeadSha,
    repositoryRoot: value.repositoryRoot,
  })
}

const SAFE_JOB_ID = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/u

export const isSafeHarnessJobId = (value: string): boolean =>
  SAFE_JOB_ID.test(value)
const SAFE_EVIDENCE =
  /^(?:check|commit|head|pr|review|test|workflow):[A-Za-z0-9][A-Za-z0-9:./_#@-]{0,220}$/u
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

export const decodeHarnessReviewPayload = (
  value: unknown,
): Effect.Effect<HarnessReviewPayload, HarnessProtocolError> => {
  if (!isRecord(value))
    return invalid("harness review payload must be an object")
  if (value.lane === "claude-code-max") {
    if (!hasExactKeys(value, COMMON_KEYS))
      return invalid("Claude review payload contains unknown fields")
    return Effect.flatMap(decodeIdentity(value), identity => {
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
  return invalid("harness lane is not registered")
}

export const decodeHarnessReviewHandoff = (
  value: unknown,
): Effect.Effect<HarnessReviewHandoff, HarnessProtocolError> => {
  if (!isRecord(value) || !hasExactKeys(value, HANDOFF_KEYS))
    return invalid("harness handoff must contain exact versioned fields")
  const evidence: string[] = []
  if (Array.isArray(value.evidence)) {
    for (const item of value.evidence) {
      if (typeof item === "string" && SAFE_EVIDENCE.test(item))
        evidence.push(item)
    }
  }
  if (
    value.protocolVersion !== 1 ||
    typeof value.jobId !== "string" ||
    !SAFE_JOB_ID.test(value.jobId) ||
    !Number.isSafeInteger(value.attempt) ||
    Number(value.attempt) < 1 ||
    Number(value.attempt) > 100 ||
    !isOneOf(HARNESS_LANES, value.lane) ||
    typeof value.repository !== "string" ||
    !SAFE_REPOSITORY.test(value.repository) ||
    !Number.isSafeInteger(value.pullRequest) ||
    Number(value.pullRequest) < 1 ||
    Number(value.pullRequest) > MAX_PULL_REQUEST ||
    typeof value.inputHeadSha !== "string" ||
    !HEAD_SHA.test(value.inputHeadSha) ||
    typeof value.outputHeadSha !== "string" ||
    !HEAD_SHA.test(value.outputHeadSha) ||
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
  return Effect.succeed({
    protocolVersion: 1,
    jobId: value.jobId,
    attempt: Number(value.attempt),
    lane: value.lane,
    repository: value.repository,
    pullRequest: Number(value.pullRequest),
    inputHeadSha: value.inputHeadSha,
    outputHeadSha: value.outputHeadSha,
    status: value.status,
    assessment: value.assessment,
    evidence,
    verifier: value.verifier,
    executorProvenance: "subscription-verified",
  })
}

export const harnessHandoffMatchesAttempt = (
  handoff: HarnessReviewHandoff,
  payload: HarnessReviewPayload,
  jobId: string,
  attempt: number,
): boolean => {
  const verifiedStatus =
    handoff.status === "clean" ||
    handoff.status === "findings_fixed" ||
    handoff.status === "findings_pending"
  return (
    handoff.jobId === jobId &&
    handoff.attempt === attempt &&
    handoff.lane === payload.lane &&
    handoff.repository === payload.repository &&
    handoff.pullRequest === payload.pullRequest &&
    handoff.inputHeadSha === payload.inputHeadSha &&
    (payload.isolation !== "read-only" ||
      (handoff.outputHeadSha === payload.inputHeadSha &&
        handoff.status !== "findings_fixed")) &&
    (!verifiedStatus || handoff.verifier === "fable-clean")
  )
}
