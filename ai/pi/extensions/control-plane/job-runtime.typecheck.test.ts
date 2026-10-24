import type { HarnessReviewHandoff } from "./harness-protocol.ts"
import type {
  HarnessReviewResult,
  Job,
  RegisteredJobSpec,
  ReviewDutyScanSpec,
} from "./job-runtime.ts"

/**
 * Compile-time regression suite for the terminal Job invariants (issue #58).
 * It carries no runtime assertions: `tsc --noEmit` over this file is the
 * test. Every `@ts-expect-error` below is a state that must stay
 * unrepresentable; if one becomes constructible again the directive turns
 * unused and the typecheck fails.
 */

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
    inputHeadSha: "a".repeat(40),
    repositoryRoot: "/Users/example/code/0xgleb/example",
    isolation: "approved-worktree",
  },
  runAt: 1_000,
  maxAttempts: 2,
}

const handoff: HarnessReviewHandoff = {
  protocolVersion: 1,
  jobId: "job-h",
  attempt: 1,
  lane: "claude-code-max",
  repository: "0xgleb/example",
  pullRequest: 7,
  inputHeadSha: "a".repeat(40),
  outputHeadSha: "a".repeat(40),
  status: "clean",
  assessment: "No verified findings.",
  evidence: ["check:review-core"],
  verifier: "fable-clean",
  executorProvenance: "subscription-verified",
}

const result: HarnessReviewResult = { kind: "harness.review", handoff }

const terminal = {
  id: "job-1",
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

// @ts-expect-error a failed job never carries a result
export const failedWithResult: Job = failedWithResultShape

const leasedWithResultShape = {
  id: "job-1",
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
