import {
  toJobId,
  type Job,
  type RegisteredJobSpec,
  type HarnessResearchResult,
} from "./job-runtime.ts"

const id = toJobId("research-typecheck")
if (id === undefined) throw new Error("fixture job ID must be valid")

const spec: RegisteredJobSpec = {
  kind: "harness.research",
  payload: {
    lane: "subscription-plan",
    harness: "claude-plan",
    profile: "research-config",
    project: "dotconfig",
    task: "subscription-harness-adversarial-review",
    repositoryRoot: "/Users/example/.config",
    isolation: "read-only",
    ownership: {
      kind: "project-domain",
      project: "dotconfig",
      role: "research-config",
    },
  },
  runAt: 1_000,
  maxAttempts: 2,
}

const result: HarnessResearchResult = {
  kind: "harness.research",
  handoff: {
    protocolVersion: 1,
    jobId: id,
    attempt: 1,
    lane: "subscription-plan",
    profile: "research-config",
    task: "subscription-harness-adversarial-review",
    status: "completed",
    summary: "Verified the bounded research task",
    evidence: ["source.ts: task boundary verified"],
  },
}

const terminal = {
  id,
  attempt: 1,
  createdAt: 1_000,
  updatedAt: 2_000,
  finishedAt: 2_000,
  summary: "done",
  spec,
} as const

export const succeeded: Job = { ...terminal, state: "succeeded", result }
export const cancelled: Job = { ...terminal, state: "cancelled", result }
export const cancelledWithoutResult: Job = { ...terminal, state: "cancelled" }
export const failed: Job = { ...terminal, attempt: 2, state: "failed" }

const failedWithResultShape = {
  ...terminal,
  attempt: 2,
  state: "failed",
  result,
} as const

// @ts-expect-error a failed attempt cannot hold a completed research result
export const failedWithResult: Job = failedWithResultShape

const leasedWithResultShape = {
  id,
  attempt: 1,
  createdAt: 1_000,
  updatedAt: 2_000,
  spec,
  state: "leased",
  workerId: "worker-a",
  leaseToken: "lease-a",
  leaseUntil: 90_000,
  result,
} as const

// @ts-expect-error an in-flight attempt cannot already hold its completed result
export const leasedWithResult: Job = leasedWithResultShape
