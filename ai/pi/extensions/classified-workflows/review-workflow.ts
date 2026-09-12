import {
  isPullRequestReviewWorkflow,
  type ReviewDutyState,
} from "./review-duty-gate.ts"
import type { WorkflowAudit, WorkflowAuditState } from "./workflow-audit.ts"

interface WorkflowIdentity {
  readonly id: string
  readonly label: string
  readonly startedAt: number
}

// Use the existing admission predicate, not arbitrary successful work in the
// session. Labels identify candidate evidence; they never grant task authority.
export const workflowMatchesReviewJob = (
  state: ReviewDutyState,
  workflow: WorkflowIdentity,
): boolean => {
  if (state.phase === "idle" || !isPullRequestReviewWorkflow(workflow))
    return false
  if (workflow.startedAt < state.startedAt) return false
  const explicitIds = [
    ...workflow.label.matchAll(/(?:\bPR\s*#?\s*|\/pull\/)(\d+)\b/gi),
  ].map(match => match[1])
  const ids =
    explicitIds.length > 0
      ? explicitIds
      : [...workflow.label.matchAll(/#(\d+)\b/g)].map(match => match[1])
  if (ids.length === 0 || ids.some(id => id !== String(state.pullRequest)))
    return false
  const withoutPullUrls = workflow.label.replace(
    /(?:https?:\/\/)?github\.com\/[^\s/]+\/[^\s/]+\/pull\/\d+/gi,
    " ",
  )
  const repositories = [
    ...workflow.label.matchAll(/github\.com\/([^\s/]+\/[^\s/]+)\/pull\/\d+/gi),
    ...withoutPullUrls.matchAll(/\b([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\b/g),
  ].map(match => match[1]?.toLowerCase())
  return repositories.every(
    repository => repository === state.repository.toLowerCase(),
  )
}

export type ReviewWorkflowSelection =
  | { readonly kind: "selected"; readonly workflow: WorkflowAudit }
  | { readonly kind: "missing"; readonly reason: string }
  | {
      readonly kind: "ambiguous"
      readonly reason: string
      readonly workflowIds: readonly string[]
    }

export const selectReviewWorkflowAudit = (
  state: ReviewDutyState,
  audits: WorkflowAuditState,
): ReviewWorkflowSelection => {
  if (state.phase !== "awaiting_report")
    return {
      kind: "missing",
      reason: "No admitted review pass awaits workflow evidence",
    }
  const candidates = audits.workflows.filter(
    workflow =>
      workflow.startedAt >= state.completedAt &&
      workflowMatchesReviewJob(state, workflow),
  )
  if (candidates.length > 1)
    return {
      kind: "ambiguous",
      reason:
        "Multiple review workflows match this admission; refusing to guess from timestamps",
      workflowIds: candidates.map(workflow => workflow.id),
    }
  const workflow = candidates[0]
  return workflow
    ? { kind: "selected", workflow }
    : {
        kind: "missing",
        reason:
          "No matching review workflow evidence exists for this admission",
      }
}
