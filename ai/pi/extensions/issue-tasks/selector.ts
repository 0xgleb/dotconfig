import { Data, Effect, Either, Schema } from "effect"
import {
  isFibonacciEffort,
  type FibonacciEffort,
} from "../shared/fibonacci-effort.ts"
import type { GitHubProjectNumberValue } from "./github-project-read.ts"
import {
  decodeIssueReference,
  issueKey,
  type IssueReference,
} from "./identity.ts"

export const MAX_ISSUE_SELECTION_CANDIDATES = 10_000

const IssuePrioritySchema = Schema.Number.pipe(
  Schema.int(),
  Schema.positive(),
  Schema.lessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
  Schema.brand("IssuePriority"),
)

export type IssuePriority = typeof IssuePrioritySchema.Type

export interface IssueSelectionEligibility {
  readonly scheduling: "active" | "held" | "deferred" | "refinement"
  readonly blockers: "clear" | "blocked" | "unknown"
  /** Clear requires a complete ancestor chain with no held/deferred ancestor. */
  readonly parent: "clear" | "held" | "unknown"
  readonly dependencies: "clear" | "blocked" | "unknown"
  /** Assignment relative to the worker for whom the host is selecting. */
  readonly ownership: "available" | "current" | "other" | "unknown"
  /** Observed owner scope for that worker, never an execution grant. */
  readonly authorization: "allowed" | "denied" | "unknown"
}

export interface IssueSelectionCandidate {
  readonly issue: IssueReference
  readonly state: "open" | "closed"
  readonly priority: GitHubProjectNumberValue
  readonly effort: GitHubProjectNumberValue
  readonly eligibility: IssueSelectionEligibility
}

export interface IssueAssignmentSnapshot {
  readonly scope: readonly IssueReference[]
  readonly coverage: "complete" | "incomplete"
  readonly candidates: readonly IssueSelectionCandidate[]
}

export type IssueIneligibilityReason =
  | "closed"
  | "held"
  | "deferred"
  | "blocked"
  | "unknown_blockers"
  | "held_parent"
  | "unknown_parent"
  | "blocked_dependencies"
  | "unknown_dependencies"
  | "owned_elsewhere"
  | "unknown_ownership"
  | "unauthorized"
  | "unknown_authorization"
  | "unranked"

export type IssueSelectionAssessment =
  | {
      readonly kind: "eligible"
      readonly issue: IssueReference
      readonly priority: IssuePriority
      readonly effort: FibonacciEffort
    }
  | {
      readonly kind: "refinement"
      readonly issue: IssueReference
      readonly reason: "missing_effort" | "scheduled_refinement"
    }
  | {
      readonly kind: "ineligible"
      readonly issue: IssueReference
      readonly reasons: readonly IssueIneligibilityReason[]
    }

export type IssueAssignmentSelection =
  | {
      readonly kind: "selected"
      readonly issue: IssueReference
      readonly assessments: readonly IssueSelectionAssessment[]
    }
  | {
      readonly kind: "none"
      readonly assessments: readonly IssueSelectionAssessment[]
    }

export class IssueSelectionError extends Data.TaggedError(
  "IssueSelectionError",
)<{
  readonly code:
    | "invalid_input"
    | "invalid_priority"
    | "invalid_effort"
    | "duplicate_issue"
    | "scope_mismatch"
    | "incomplete_snapshot"
    | "capacity"
  readonly message: string
}> {}

/**
 * Coverage is caller-attested for the explicit scope, not proof of complete
 * Project pagination. Supply every scoped issue, including ineligible rows.
 * Selection neither persists assignments nor replaces current execution checks.
 */
export const selectIssueAssignment = (
  input: unknown,
): Effect.Effect<IssueAssignmentSelection, IssueSelectionError> =>
  Effect.gen(function* () {
    const candidates = yield* Either.try({
      try: () => decodeSnapshot(input),
      catch: () => selectionError("invalid_input"),
    }).pipe(Either.flatMap(result => result))
    const assessments = Object.freeze(candidates.map(assessCandidate))
    let selected: EligibleAssessment | undefined

    for (const assessment of assessments) {
      if (assessment.kind !== "eligible") continue
      if (selected === undefined || compareCandidates(assessment, selected) < 0)
        selected = assessment
    }

    return selected === undefined
      ? Object.freeze({ kind: "none", assessments })
      : Object.freeze({ kind: "selected", issue: selected.issue, assessments })
  })

const NumberInputSchema = Schema.Union(
  Schema.Struct({ kind: Schema.Literal("unset") }),
  Schema.Struct({ kind: Schema.Literal("number"), value: Schema.Unknown }),
)

const EligibilitySchema = Schema.Struct({
  scheduling: Schema.Literal("active", "held", "deferred", "refinement"),
  blockers: Schema.Literal("clear", "blocked", "unknown"),
  parent: Schema.Literal("clear", "held", "unknown"),
  dependencies: Schema.Literal("clear", "blocked", "unknown"),
  ownership: Schema.Literal("available", "current", "other", "unknown"),
  authorization: Schema.Literal("allowed", "denied", "unknown"),
})

const CandidateSchema = Schema.Struct({
  issue: Schema.Unknown,
  state: Schema.Literal("open", "closed"),
  priority: NumberInputSchema,
  effort: NumberInputSchema,
  eligibility: EligibilitySchema,
})

const SnapshotSchema = Schema.Struct({
  scope: Schema.Unknown,
  coverage: Schema.Literal("complete", "incomplete"),
  candidates: Schema.Unknown,
})

const EffortSchema = Schema.declare(isFibonacciEffort)

type SelectionNumber<A> =
  { readonly kind: "unset" } | { readonly kind: "number"; readonly value: A }

interface ValidatedCandidate extends Omit<
  IssueSelectionCandidate,
  "priority" | "effort"
> {
  readonly priority: SelectionNumber<IssuePriority>
  readonly effort: SelectionNumber<FibonacciEffort>
}

type EligibleAssessment = Extract<
  IssueSelectionAssessment,
  { kind: "eligible" }
>

const selectionError = (code: IssueSelectionError["code"]) =>
  new IssueSelectionError({
    code,
    message: {
      invalid_input: "Issue assignment input has an invalid shape or identity.",
      invalid_priority:
        "Priority must be unset or a positive safe-integer rank.",
      invalid_effort: "Effort must be unset or positive safe Fibonacci points.",
      duplicate_issue:
        "Issue assignment input contains duplicate qualified issues.",
      scope_mismatch: "Candidates must cover the explicit issue scope exactly.",
      incomplete_snapshot:
        "Issue assignment requires a caller-complete snapshot.",
      capacity: "Issue assignment input exceeds the candidate capacity.",
    }[code],
  })

const decode = <A, I>(schema: Schema.Schema<A, I>, value: unknown) =>
  Schema.decodeUnknownEither(schema, { onExcessProperty: "error" })(value).pipe(
    Either.mapLeft(() => selectionError("invalid_input")),
  )

const decodeCandidate = (
  input: unknown,
): Either.Either<ValidatedCandidate, IssueSelectionError> =>
  Either.gen(function* () {
    const raw = yield* decode(CandidateSchema, input)
    const issue = yield* decodeIssueReference(raw.issue).pipe(
      Either.mapLeft(() => selectionError("invalid_input")),
    )
    const priority =
      raw.priority.kind === "unset"
        ? raw.priority
        : Object.freeze({
            kind: "number" as const,
            value: yield* Schema.decodeUnknownEither(IssuePrioritySchema)(
              raw.priority.value,
            ).pipe(Either.mapLeft(() => selectionError("invalid_priority"))),
          })
    const effort =
      raw.effort.kind === "unset"
        ? raw.effort
        : Object.freeze({
            kind: "number" as const,
            value: yield* Schema.decodeUnknownEither(EffortSchema)(
              raw.effort.value,
            ).pipe(Either.mapLeft(() => selectionError("invalid_effort"))),
          })

    return Object.freeze({
      issue,
      state: raw.state,
      priority,
      effort,
      eligibility: Object.freeze(raw.eligibility),
    })
  })

const decodeSnapshot = (
  input: unknown,
): Either.Either<readonly ValidatedCandidate[], IssueSelectionError> =>
  Either.gen(function* () {
    const raw = yield* decode(SnapshotSchema, input)

    if (!Array.isArray(raw.scope) || !Array.isArray(raw.candidates))
      return yield* Either.left(selectionError("invalid_input"))
    if (
      raw.scope.length > MAX_ISSUE_SELECTION_CANDIDATES ||
      raw.candidates.length > MAX_ISSUE_SELECTION_CANDIDATES
    )
      return yield* Either.left(selectionError("capacity"))
    if (raw.coverage === "incomplete")
      return yield* Either.left(selectionError("incomplete_snapshot"))

    const scope = yield* Either.all(
      Array.from(raw.scope, issue =>
        decodeIssueReference(issue).pipe(
          Either.mapLeft(() => selectionError("invalid_input")),
        ),
      ),
    )
    const candidates = yield* Either.all(
      Array.from(raw.candidates, decodeCandidate),
    )
    const scopeKeys = new Set(scope.map(issueKey))
    const candidateKeys = new Set(
      candidates.map(candidate => issueKey(candidate.issue)),
    )

    if (
      scopeKeys.size !== scope.length ||
      candidateKeys.size !== candidates.length
    )
      return yield* Either.left(selectionError("duplicate_issue"))
    if (
      scopeKeys.size !== candidateKeys.size ||
      [...candidateKeys].some(key => !scopeKeys.has(key))
    )
      return yield* Either.left(selectionError("scope_mismatch"))

    return Object.freeze(candidates)
  })

const assessCandidate = (
  candidate: ValidatedCandidate,
): IssueSelectionAssessment => {
  const { issue, priority, effort, eligibility } = candidate
  const reasons: IssueIneligibilityReason[] = []

  if (candidate.state === "closed") reasons.push("closed")
  if (eligibility.scheduling === "held") reasons.push("held")
  if (eligibility.scheduling === "deferred") reasons.push("deferred")
  if (eligibility.blockers === "blocked") reasons.push("blocked")
  if (eligibility.blockers === "unknown") reasons.push("unknown_blockers")
  if (eligibility.parent === "held") reasons.push("held_parent")
  if (eligibility.parent === "unknown") reasons.push("unknown_parent")
  if (eligibility.dependencies === "blocked")
    reasons.push("blocked_dependencies")
  if (eligibility.dependencies === "unknown")
    reasons.push("unknown_dependencies")
  if (eligibility.ownership === "other") reasons.push("owned_elsewhere")
  if (eligibility.ownership === "unknown") reasons.push("unknown_ownership")
  if (eligibility.authorization === "denied") reasons.push("unauthorized")
  if (eligibility.authorization === "unknown")
    reasons.push("unknown_authorization")

  if (priority.kind === "unset" || reasons.length > 0) {
    if (priority.kind === "unset") reasons.push("unranked")
    return Object.freeze({
      kind: "ineligible",
      issue,
      reasons: Object.freeze(reasons),
    })
  }
  if (eligibility.scheduling === "refinement")
    return Object.freeze({
      kind: "refinement",
      issue,
      reason: "scheduled_refinement",
    })
  if (effort.kind === "unset")
    return Object.freeze({
      kind: "refinement",
      issue,
      reason: "missing_effort",
    })

  return Object.freeze({
    kind: "eligible",
    issue,
    priority: priority.value,
    effort: effort.value,
  })
}

const compareCandidates = (
  left: EligibleAssessment,
  right: EligibleAssessment,
): number => {
  const leftScore = BigInt(left.priority) * BigInt(left.effort)
  const rightScore = BigInt(right.priority) * BigInt(right.effort)

  if (leftScore !== rightScore) return leftScore < rightScore ? -1 : 1
  if (left.priority !== right.priority)
    return left.priority < right.priority ? -1 : 1
  if (left.issue.repository !== right.issue.repository)
    return left.issue.repository < right.issue.repository ? -1 : 1
  if (left.issue.number === right.issue.number) return 0
  return left.issue.number < right.issue.number ? -1 : 1
}
