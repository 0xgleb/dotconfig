import {
  isPullRequestReviewWorkflow,
  type ReviewDutyState,
} from "./review-duty-gate.ts"
import type { WorkflowAudit, WorkflowAuditState } from "./workflow-audit.ts"

interface WorkflowIdentity {
  readonly id: string
  readonly label: string
  readonly startedAt: number
  readonly children?: readonly { readonly task?: string }[]
}

const declaresRepairScope = (task: string | undefined): boolean =>
  task !== undefined &&
  /^(?:same\s+continued\s+)?(?:own|assigned|auto)\s+PR\s*#?\s*\d+\s+fix[ /-]re-review\b/i.test(
    task,
  )

// Use the existing admission predicate, not arbitrary successful work in the
// session. Labels identify candidate evidence; they never grant task authority.
export const workflowMatchesReviewJob = (
  state: ReviewDutyState,
  workflow: WorkflowIdentity,
): boolean => {
  if (
    state.phase === "idle" ||
    !isPullRequestReviewWorkflow(workflow) ||
    workflow.children?.some(child => declaresRepairScope(child.task))
  )
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

export type ReviewContinuationSelection =
  | {
      readonly kind: "selected"
      readonly workflow: WorkflowAudit
      readonly evidenceKind: "review" | "repair"
    }
  | Exclude<ReviewWorkflowSelection, { readonly kind: "selected" }>

// Legacy repair workflows retain explicit same-job scope in child task
// prefixes, not necessarily in their descriptive workflow label. This may
// resume repairs, but never establishes a completed whole-PR review.
const repairTaskMatchesJob = (
  state: Exclude<ReviewDutyState, { readonly phase: "idle" }>,
  task: string | undefined,
): boolean => {
  if (task === undefined) return false
  const scope = task.match(
    /^same\s+continued\s+(own|assigned|auto)\s+PR\s*#?\s*(\d+)\s+fix[ /-]re-review\b/i,
  )
  if (
    !scope ||
    scope[1]?.toLowerCase() !== state.kind ||
    scope[2] !== String(state.pullRequest)
  )
    return false
  const ids = [...task.matchAll(/(?:\bPR\s*#?\s*|\/pull\/|#)(\d+)\b/gi)]
  const pullUrl =
    /(?<![A-Za-z0-9_.:/-])(?:https?:\/\/)?github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/pull\/[1-9]\d*(?=$|[\s)\]}'",;`])/gi
  const urls = [...task.matchAll(pullUrl)]
  if ([...task.matchAll(/github\.com/gi)].length !== urls.length) return false
  const withoutPullUrls = task.slice(scope[0].length).replace(pullUrl, " ")
  const repositories = [
    ...urls,
    // Bare two-component repository identifiers agree regardless of punctuation.
    // Longer relative source paths (e.g. SPEC/ROADMAP/ADR/source) are not repo IDs.
    ...withoutPullUrls.matchAll(
      /(?<![A-Za-z0-9_./-])([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)(?![A-Za-z0-9_./-])/g,
    ),
  ]
  return (
    ids.every(match => match[1] === String(state.pullRequest)) &&
    repositories.every(
      match => match[1]?.toLowerCase() === state.repository.toLowerCase(),
    )
  )
}

export const selectReviewContinuationAudit = (
  state: ReviewDutyState,
  audits: WorkflowAuditState,
  running: readonly { readonly status: string; readonly startedAt: number }[],
): ReviewContinuationSelection => {
  const review = selectReviewWorkflowAudit(state, audits)
  const baseline: ReviewContinuationSelection =
    review.kind === "selected" ? { ...review, evidenceKind: "review" } : review
  if (
    review.kind === "ambiguous" ||
    state.phase !== "awaiting_report" ||
    state.continuation !== "fix-re-review"
  )
    return baseline
  if (
    running.some(
      workflow =>
        workflow.status === "running" &&
        workflow.startedAt >= state.completedAt,
    )
  )
    return {
      kind: "missing",
      reason: "The current review-duty admission still has running work",
    }
  const candidates = audits.workflows.filter(workflow => {
    const ids = [
      ...workflow.label.matchAll(/(?:\bPR\s*#?\s*|\/pull\/|#)(\d+)\b/gi),
    ]
    const labelScope = {
      id: workflow.id,
      startedAt: workflow.startedAt,
      label: `Review PR${state.pullRequest} ${workflow.label}`,
    }
    return (
      workflow.status === "completed" &&
      workflow.startedAt >= state.completedAt &&
      ids.every(match => match[1] === String(state.pullRequest)) &&
      workflowMatchesReviewJob(state, labelScope) &&
      workflow.children.length > 0 &&
      workflow.children.every(child =>
        repairTaskMatchesJob(state, child.task),
      ) &&
      workflow.children.some(
        child => child.status === "completed" && child.outputCharacters > 0,
      )
    )
  })
  const candidateIds = [
    ...(baseline.kind === "selected" ? [baseline.workflow.id] : []),
    ...candidates.map(workflow => workflow.id),
  ]
  if (candidateIds.length > 1)
    return {
      kind: "ambiguous",
      reason:
        "Multiple review or scoped repair workflows match this admission; refusing to guess",
      workflowIds: candidateIds,
    }
  const workflow = candidates[0]
  return workflow
    ? { kind: "selected", workflow, evidenceKind: "repair" }
    : baseline
}
