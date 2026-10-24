import { Data, Effect } from "effect"

export const HARNESS_SUPPORT_AREAS = [
  "infrastructure",
  "tooling",
  "classifier",
  "reload",
  "observability",
  "operator-support",
] as const

export type HarnessSupportArea = (typeof HARNESS_SUPPORT_AREAS)[number]

export type HarnessResearchOwnership =
  | {
      readonly kind: "project-domain"
      readonly project: string
      readonly role: string
    }
  | {
      readonly kind: "agentops-support"
      readonly project: string
      readonly role: string
      readonly supportArea: HarnessSupportArea
    }

export interface HarnessResearchPayload {
  readonly lane: "subscription-plan"
  readonly harness: string
  readonly profile: string
  readonly project: string
  readonly task: string
  readonly repositoryRoot: string
  readonly isolation: "read-only"
  /** Absent only on persisted legacy jobs. New admission requires ownership. */
  readonly ownership?: HarnessResearchOwnership
}

export type NewHarnessResearchPayload = HarnessResearchPayload & {
  readonly ownership: HarnessResearchOwnership
}

export interface HarnessResearchHandoff {
  readonly protocolVersion: 1
  readonly jobId: string
  readonly attempt: number
  readonly lane: "subscription-plan"
  readonly profile: string
  readonly task: string
  readonly status: "completed"
  readonly summary: string
  readonly evidence: readonly string[]
}

export class HarnessResearchProtocolError extends Data.TaggedError(
  "HarnessResearchProtocolError",
)<{
  readonly code: "invalid_payload" | "invalid_handoff"
  readonly message: string
}> {}

const SAFE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9:._-]*$/u
const UNSAFE_CONTROL = /[\u0000-\u001f\u007f]/u

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const exactKeys = (
  value: Readonly<Record<string, unknown>>,
  expected: readonly string[],
): boolean =>
  Object.keys(value).length === expected.length &&
  Object.keys(value).every(key => expected.includes(key))

const safeIdentifier = (value: unknown, maximum = 256): value is string =>
  typeof value === "string" &&
  value.length >= 1 &&
  value.length <= maximum &&
  SAFE_IDENTIFIER.test(value)

const boundedText = (value: unknown, maximum: number): value is string =>
  typeof value === "string" &&
  value.trim().length >= 1 &&
  value.length <= maximum &&
  !UNSAFE_CONTROL.test(value)

const canonicalAbsolutePath = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length >= 1 &&
  value.length <= 1_024 &&
  value.startsWith("/") &&
  !UNSAFE_CONTROL.test(value) &&
  (value === "/" ||
    (!value.endsWith("/") &&
      value
        .split("/")
        .slice(1)
        .every(
          segment => segment.length > 0 && segment !== "." && segment !== "..",
        )))

const invalidPayload = <A>(
  message: string,
): Effect.Effect<A, HarnessResearchProtocolError> =>
  Effect.fail(
    new HarnessResearchProtocolError({ code: "invalid_payload", message }),
  )

const decodeOwnership = (
  value: unknown,
  project: string,
  profile: string,
): HarnessResearchOwnership | undefined => {
  if (
    !isRecord(value) ||
    typeof value.project !== "string" ||
    value.project !== project ||
    typeof value.role !== "string"
  )
    return undefined
  if (value.kind === "project-domain") {
    if (
      !exactKeys(value, ["kind", "project", "role"]) ||
      !safeIdentifier(value.role, 128) ||
      value.role !== profile ||
      value.role.startsWith("agentops-")
    )
      return undefined
    return { kind: value.kind, project: value.project, role: value.role }
  }
  if (
    value.kind !== "agentops-support" ||
    !exactKeys(value, ["kind", "project", "role", "supportArea"]) ||
    !safeIdentifier(value.role, 128) ||
    value.role !== profile ||
    value.role !== `agentops-${project}` ||
    !HARNESS_SUPPORT_AREAS.includes(value.supportArea as HarnessSupportArea)
  )
    return undefined
  return {
    kind: value.kind,
    project: value.project,
    role: value.role,
    supportArea: value.supportArea as HarnessSupportArea,
  }
}

const invalidHandoff = <A>(
  message: string,
): Effect.Effect<A, HarnessResearchProtocolError> =>
  Effect.fail(
    new HarnessResearchProtocolError({ code: "invalid_handoff", message }),
  )

export const decodeHarnessResearchPayload = (
  value: unknown,
): Effect.Effect<HarnessResearchPayload, HarnessResearchProtocolError> => {
  if (!isRecord(value))
    return invalidPayload("harness research payload is malformed")
  const hasOwnership = "ownership" in value
  if (
    !exactKeys(
      value,
      hasOwnership
        ? [
            "lane",
            "harness",
            "profile",
            "project",
            "task",
            "repositoryRoot",
            "isolation",
            "ownership",
          ]
        : [
            "lane",
            "harness",
            "profile",
            "project",
            "task",
            "repositoryRoot",
            "isolation",
          ],
    ) ||
    value.lane !== "subscription-plan" ||
    !safeIdentifier(value.harness, 64) ||
    !safeIdentifier(value.profile, 128) ||
    !safeIdentifier(value.project, 128) ||
    !safeIdentifier(value.task, 128) ||
    !canonicalAbsolutePath(value.repositoryRoot) ||
    value.isolation !== "read-only"
  )
    return invalidPayload("harness research payload is malformed")
  const ownership = hasOwnership
    ? decodeOwnership(value.ownership, value.project, value.profile)
    : undefined
  if (hasOwnership && ownership === undefined)
    return invalidPayload("harness research ownership is malformed")
  return Effect.succeed({
    lane: value.lane,
    harness: value.harness,
    profile: value.profile,
    project: value.project,
    task: value.task,
    repositoryRoot: value.repositoryRoot,
    isolation: value.isolation,
    ...(ownership ? { ownership } : {}),
  })
}

export const validateNewHarnessResearchPayload = (
  value: unknown,
): Effect.Effect<NewHarnessResearchPayload, HarnessResearchProtocolError> =>
  Effect.flatMap(decodeHarnessResearchPayload(value), payload =>
    payload.ownership
      ? Effect.succeed(payload as NewHarnessResearchPayload)
      : invalidPayload("new harness research jobs require typed ownership"),
  )

export const decodeHarnessResearchHandoff = (
  value: unknown,
): Effect.Effect<HarnessResearchHandoff, HarnessResearchProtocolError> => {
  if (
    !isRecord(value) ||
    !exactKeys(value, [
      "protocolVersion",
      "jobId",
      "attempt",
      "lane",
      "profile",
      "task",
      "status",
      "summary",
      "evidence",
    ]) ||
    value.protocolVersion !== 1 ||
    !safeIdentifier(value.jobId, 128) ||
    !Number.isSafeInteger(value.attempt) ||
    Number(value.attempt) < 1 ||
    Number(value.attempt) > 100 ||
    value.lane !== "subscription-plan" ||
    !safeIdentifier(value.profile, 128) ||
    !safeIdentifier(value.task, 128) ||
    value.status !== "completed" ||
    !boundedText(value.summary, 512) ||
    !Array.isArray(value.evidence) ||
    value.evidence.length < 1 ||
    value.evidence.length > 16 ||
    !value.evidence.every(line => boundedText(line, 512))
  )
    return invalidHandoff("harness research handoff is malformed")
  return Effect.succeed(value as unknown as HarnessResearchHandoff)
}

export const harnessResearchHandoffMatchesAttempt = (
  handoff: HarnessResearchHandoff,
  payload: HarnessResearchPayload,
  jobId: string,
  attempt: number,
): boolean =>
  handoff.jobId === jobId &&
  handoff.attempt === attempt &&
  handoff.lane === payload.lane &&
  handoff.profile === payload.profile &&
  handoff.task === payload.task
