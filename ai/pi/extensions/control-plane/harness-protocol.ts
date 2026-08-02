import { isAbsolute, normalize } from "node:path"
import { Data, Effect } from "effect"
import {
  automaticRepositoryForProfile,
  repositoryAllowedForProfile,
  REVIEW_DUTY_PROFILES,
  type ReviewDutyProfile,
} from "./review-duty-profile.ts"

export const HARNESS_LANES = ["claude-code-max", "cursor-subscription"] as const
export const CURSOR_REVIEW_MODELS = ["grok-4.5", "composer-2.5"] as const

export type HarnessLane = (typeof HARNESS_LANES)[number]
export type CursorReviewModel = (typeof CURSOR_REVIEW_MODELS)[number]
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
      readonly task: "review-loop" | "review-pr"
      readonly isolation: "read-only" | "approved-worktree"
    })
  | (HarnessReviewIdentity & {
      readonly lane: "cursor-subscription"
      readonly task: "review-probe"
      readonly model: CursorReviewModel
      readonly isolation: "read-only"
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

const hasExactKeys = (
  value: Readonly<Record<string, unknown>>,
  expected: readonly string[],
): boolean =>
  Object.keys(value).length === expected.length &&
  Object.keys(value).every((key) => expected.includes(key))

const SAFE_REPOSITORY = /^[a-z0-9][a-z0-9._-]{0,63}\/[a-z0-9][a-z0-9._-]{0,99}$/u
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
  isAbsolute(value) &&
  normalize(value) === value

const decodeIdentity = (
  value: Readonly<Record<string, unknown>>,
): Effect.Effect<HarnessReviewIdentity, HarnessProtocolError> => {
  if (
    !REVIEW_DUTY_PROFILES.includes(value.profile as ReviewDutyProfile) ||
    typeof value.repository !== "string" ||
    !SAFE_REPOSITORY.test(value.repository) ||
    !Number.isSafeInteger(value.pullRequest) ||
    Number(value.pullRequest) < 1 ||
    Number(value.pullRequest) > MAX_PULL_REQUEST ||
    (value.kind !== "own" &&
      value.kind !== "assigned" &&
      value.kind !== "auto") ||
    typeof value.inputHeadSha !== "string" ||
    !HEAD_SHA.test(value.inputHeadSha) ||
    !isCanonicalAbsolutePath(value.repositoryRoot)
  ) {
    return invalid("harness review identity is malformed")
  }
  const profile = value.profile as ReviewDutyProfile
  const repository = value.repository
  if (!repositoryAllowedForProfile(profile, repository))
    return invalid("repository is outside the selected review profile")
  if (
    value.kind === "auto" &&
    automaticRepositoryForProfile(profile) !== repository
  ) {
    return invalid("automatic review is not registered for this repository")
  }
  return Effect.succeed({
    profile,
    repository,
    pullRequest: Number(value.pullRequest),
    kind: value.kind,
    inputHeadSha: value.inputHeadSha,
    repositoryRoot: value.repositoryRoot,
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

export const decodeHarnessReviewPayload = (
  value: unknown,
): Effect.Effect<HarnessReviewPayload, HarnessProtocolError> => {
  if (!isRecord(value)) return invalid("harness review payload must be an object")
  if (value.lane === "claude-code-max") {
    if (!hasExactKeys(value, COMMON_KEYS))
      return invalid("Claude review payload contains unknown fields")
    return Effect.flatMap(decodeIdentity(value), (identity) => {
      const expectedTask = identity.kind === "assigned" ? "review-pr" : "review-loop"
      const expectedIsolation =
        identity.kind === "assigned" ? "read-only" : "approved-worktree"
      if (value.task !== expectedTask || value.isolation !== expectedIsolation)
        return invalid("Claude review task and isolation do not match its kind")
      return Effect.succeed({
        ...identity,
        lane: "claude-code-max",
        task: expectedTask,
        isolation: expectedIsolation,
      })
    })
  }
  if (value.lane === "cursor-subscription") {
    if (!hasExactKeys(value, [...COMMON_KEYS, "model"]))
      return invalid("Cursor review payload contains unknown fields")
    return Effect.flatMap(decodeIdentity(value), (identity) => {
      if (
        value.task !== "review-probe" ||
        value.isolation !== "read-only" ||
        identity.kind === "auto" ||
        !CURSOR_REVIEW_MODELS.includes(value.model as CursorReviewModel)
      ) {
        return invalid("Cursor review lane must be a registered read-only probe")
      }
      return Effect.succeed({
        ...identity,
        lane: "cursor-subscription",
        task: "review-probe",
        model: value.model as CursorReviewModel,
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
  if (
    value.protocolVersion !== 1 ||
    typeof value.jobId !== "string" ||
    !SAFE_JOB_ID.test(value.jobId) ||
    !Number.isSafeInteger(value.attempt) ||
    Number(value.attempt) < 1 ||
    Number(value.attempt) > 100 ||
    !HARNESS_LANES.includes(value.lane as HarnessLane) ||
    typeof value.repository !== "string" ||
    !SAFE_REPOSITORY.test(value.repository) ||
    !Number.isSafeInteger(value.pullRequest) ||
    Number(value.pullRequest) < 1 ||
    Number(value.pullRequest) > MAX_PULL_REQUEST ||
    typeof value.inputHeadSha !== "string" ||
    !HEAD_SHA.test(value.inputHeadSha) ||
    typeof value.outputHeadSha !== "string" ||
    !HEAD_SHA.test(value.outputHeadSha) ||
    !HANDOFF_STATUSES.includes(
      value.status as HarnessReviewHandoff["status"],
    ) ||
    typeof value.assessment !== "string" ||
    value.assessment.trim().length < 1 ||
    value.assessment.length > 500 ||
    UNSAFE_CONTROL.test(value.assessment) ||
    !Array.isArray(value.evidence) ||
    value.evidence.length > 16 ||
    !value.evidence.every(
      (item) => typeof item === "string" && SAFE_EVIDENCE.test(item),
    ) ||
    !HANDOFF_VERIFIERS.includes(
      value.verifier as HarnessReviewHandoff["verifier"],
    ) ||
    value.executorProvenance !== "subscription-verified"
  ) {
    return invalid("harness handoff fields are malformed")
  }
  return Effect.succeed({
    protocolVersion: 1,
    jobId: value.jobId,
    attempt: Number(value.attempt),
    lane: value.lane as HarnessLane,
    repository: value.repository,
    pullRequest: Number(value.pullRequest),
    inputHeadSha: value.inputHeadSha,
    outputHeadSha: value.outputHeadSha,
    status: value.status as HarnessReviewHandoff["status"],
    assessment: value.assessment,
    evidence: value.evidence as string[],
    verifier: value.verifier as HarnessReviewHandoff["verifier"],
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
