import assert from "node:assert/strict"
import { toCommitSha, toJobId } from "./harness-protocol.ts"
import { canonicalPath } from "./review-duty-profile.ts"
import type {
  VerifiedHarnessHandoff,
  VerifiedHarnessReviewResult,
  Job,
  RegisteredJobSpec,
  ReviewDutyScanSpec,
} from "./job-runtime.ts"

/**
 * Compile-time regression suite for the terminal Job invariants (issue #58).
 * Fixture assertions construct valid domain values; `tsc --noEmit` is the
 * regression check. Every `@ts-expect-error` below is a state that must stay
 * unrepresentable; if one becomes constructible again the directive turns
 * unused and the typecheck fails.
 */

const fixtureId = toJobId("job-1")
assert.ok(fixtureId !== undefined)

const headSha = toCommitSha("a".repeat(40))
assert.ok(headSha !== undefined)

const repositoryRoot = canonicalPath("/Users/example/code/0xgleb/example")
assert.ok(repositoryRoot !== undefined)

type HarnessReviewSpec = Extract<
  RegisteredJobSpec,
  { readonly kind: "harness.review" }
>

const scanSpec: ReviewDutyScanSpec = {
  kind: "review-duty.scan",
  payload: { profile: "st0x-review" },
  runAt: 1_000,
  maxAttempts: 3,
}

const harnessSpec: HarnessReviewSpec = {
  kind: "harness.review",
  payload: {
    lane: "claude-code-max",
    task: "review-loop",
    profile: "personal-review",
    repository: "0xgleb/example",
    pullRequest: 7,
    kind: "own",
    inputHeadSha: headSha,
    repositoryRoot,
    isolation: "approved-worktree",
  },
  runAt: 1_000,
  maxAttempts: 2,
}

const handoff: VerifiedHarnessHandoff = {
  protocolVersion: 1,
  jobId: fixtureId,
  attempt: 1,
  lane: "claude-code-max",
  repository: "0xgleb/example",
  pullRequest: 7,
  inputHeadSha: headSha,
  outputHeadSha: headSha,
  status: "clean",
  assessment: "No verified findings.",
  evidence: ["check:review-core"],
  verifier: "fable-clean",
  executorProvenance: "subscription-verified",
}

const result: VerifiedHarnessReviewResult = { kind: "harness.review", handoff }

const terminal = {
  id: fixtureId,
  attempt: 1,
  createdAt: 1_000,
  updatedAt: 2_000,
  finishedAt: 2_000,
  summary: "done",
} as const

export const harnessSucceeded: Job = {
  ...terminal,
  spec: harnessSpec,
  state: "succeeded",
  result,
}

export const harnessCancelledWithResult: Job = {
  ...terminal,
  spec: harnessSpec,
  state: "cancelled",
  result,
}

export const harnessCancelledWithoutResult: Job = {
  ...terminal,
  spec: harnessSpec,
  state: "cancelled",
}

export const scanSucceeded: Job = {
  ...terminal,
  spec: scanSpec,
  state: "succeeded",
}

export const harnessFailed: Job = {
  ...terminal,
  attempt: 2,
  spec: harnessSpec,
  state: "failed",
}

const harnessSucceededWithoutResultShape = {
  ...terminal,
  spec: harnessSpec,
  state: "succeeded",
} as const

// @ts-expect-error a successful harness job must carry its typed result
export const harnessSucceededWithoutResult: Job =
  harnessSucceededWithoutResultShape

const scanSucceededWithResultShape = {
  ...terminal,
  spec: scanSpec,
  state: "succeeded",
  result,
} as const

// @ts-expect-error a review-duty scan job can never carry a harness result
export const scanSucceededWithResult: Job = scanSucceededWithResultShape

const scanCancelledWithResultShape = {
  ...terminal,
  spec: scanSpec,
  state: "cancelled",
  result,
} as const

// @ts-expect-error a cancelled scan job can never carry a harness result
export const scanCancelledWithResult: Job = scanCancelledWithResultShape

const failedWithResultShape = {
  ...terminal,
  attempt: 2,
  spec: harnessSpec,
  state: "failed",
  result,
} as const

// @ts-expect-error a failed harness job cannot carry a verified review result
export const failedWithResult: Job = failedWithResultShape

const leasedWithResultShape = {
  id: fixtureId,
  attempt: 1,
  createdAt: 1_000,
  updatedAt: 2_000,
  spec: harnessSpec,
  state: "leased",
  workerId: "worker-a",
  leaseToken: "lease-a",
  leaseUntil: 90_000,
  result,
} as const

// @ts-expect-error a leased job never carries a result
export const leasedWithResult: Job = leasedWithResultShape

const nonterminal = {
  id: fixtureId,
  attempt: 0,
  createdAt: 1_000,
  updatedAt: 2_000,
} as const

const scheduledWithResultShape = {
  ...nonterminal,
  spec: { ...harnessSpec, runAt: 5_000 },
  state: "scheduled",
  result,
} as const

// @ts-expect-error a scheduled job cannot carry a result from an attempt
export const scheduledWithResult: Job = scheduledWithResultShape

const readyWithResultShape = {
  ...nonterminal,
  spec: harnessSpec,
  state: "ready",
  result,
} as const

// @ts-expect-error a ready job cannot carry a result from an attempt
export const readyWithResult: Job = readyWithResultShape

const retryingWithResultShape = {
  ...nonterminal,
  spec: { ...harnessSpec, runAt: 5_000 },
  state: "retry_wait",
  attempt: 1,
  lastAttemptSummary: "retry scheduled",
  result,
} as const

// @ts-expect-error a retrying job retains a summary, not a terminal result
export const retryingWithResult: Job = retryingWithResultShape
