import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { stripTypeScriptTypes } from "node:module"
import test from "node:test"
import * as gate from "./review-duty-gate.ts"
import * as audit from "./workflow-audit.ts"
import * as review from "./review-workflow.ts"

const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8")
const job = {
  phase: "awaiting_report",
  repository: "dataclique/yielduck",
  pullRequest: 274,
  kind: "own",
  startedAt: 10,
  completedAt: 20,
} as const

const invoke = (
  action: "retry-failed" | "complete-auto" | "continue" | "release-unusable",
  workflows: readonly Record<string, unknown>[],
  running: readonly Record<string, unknown>[] = [],
  state: gate.ReviewDutyState = job,
) => {
  const start = source.indexOf(`      if (request.action === "${action}") {`)
  const nextMarker =
    action === "release-unusable"
      ? "      if (request.questionId === undefined) {"
      : `      if (request.action === "${action === "continue" ? "complete-auto" : action === "retry-failed" ? "release-unusable" : "retry-failed"}") {`
  const end = source.indexOf(nextMarker, start)
  assert.ok(start >= 0 && end > start)
  return new Function(
    "dependencies",
    `
    const {
      action, workflows, running, job, selectReviewWorkflowAudit, workflowMatchesReviewJob,
      retryFailedReviewDuty, completeAutoReviewDuty, continueReviewDuty, releaseUnusableReviewDuty, reviewDutyJobAllowed,
      latestFailedWorkflowAfter, latestCompletedWorkflowAfter,
      latestManagedReloadCancellationAfter, latestLegacyUnmarkedCancellationAfter,
    } = dependencies;
    const request = { action };
    const ctx = { sessionManager: { getBranch: () => [] } };
    const dutySessionName = "dataclique-review-duty";
    const refreshWorkflowAudits = () => {};
    const latestContinuationPause = () => false;
    const managedReloadCompletionObservedAfterAudit = () => false;
    let reviewDutyState = job;
    const workflowAudits = { workflows };
    const backgroundWorkflows = new Map(running.map(workflow => [workflow.id, workflow]));
    const pi = { appendEntry: () => {} };
    const REVIEW_DUTY_STATE_ENTRY = "review-duty";
    ${stripTypeScriptTypes(`const run = () => {\n${source.slice(start, end)}\n}`)}
    return run();
  `,
  )({ ...gate, ...audit, ...review, action, workflows, running, job: state })
}

const failedReview = {
  id: "wf-6",
  label: "Review Yielduck PR #274",
  status: "failed",
  startedAt: 21,
  finishedAt: 50,
  children: Array.from({ length: 32 }, (_, index) => ({
    index: index + 1,
    status: index < 27 ? "completed" : "failed",
    outputCharacters: index < 27 ? 3_000 : 0,
    ...(index < 27 ? { retainedOutput: "Partial review evidence" } : {}),
  })),
}
const issueMapping = {
  id: "wf-9",
  label: "Map open issues",
  status: "completed",
  startedAt: 30,
  finishedAt: 40,
  children: [{ index: 1, status: "completed", outputCharacters: 1_000 }],
}

test("actual retry-failed preserves the failed review despite later-created incidental work", () => {
  const result = invoke("retry-failed", [failedReview, issueMapping])
  assert.equal(result.details.outcome, "retry-failed")
  assert.equal(result.details.recoveredAuditId, "wf-6")
  assert.equal(result.details.partialChildren.length, 27)
  assert.equal(result.details.state.repository, job.repository)
  assert.equal(result.details.state.pullRequest, job.pullRequest)
})

test("actual complete-auto cannot substitute incidental completed output for a failed review", () => {
  const result = invoke("complete-auto", [failedReview, issueMapping])
  assert.equal(result.isError, true)
  assert.notEqual(result.details.outcome, "complete-auto")
})

for (const action of ["retry-failed", "complete-auto"] as const) {
  test(`actual ${action} rejects missing, stale, foreign and ambiguous review evidence`, () => {
    for (const workflows of [
      [issueMapping],
      [{ ...failedReview, startedAt: 19 }],
      [{ ...failedReview, label: "Review PR275" }],
      [{ ...failedReview, label: "Review PR #274 for dataclique/other" }],
      [
        {
          ...failedReview,
          label: "Review https://github.com/dataclique/other/pull/274",
        },
      ],
      [failedReview, { ...failedReview, id: "wf-10", startedAt: 22 }],
    ]) {
      const result = invoke(
        action,
        workflows.map(workflow => ({
          ...workflow,
          status: action === "complete-auto" ? "completed" : workflow.status,
        })),
      )
      assert.equal(result.isError, true)
      assert.equal(result.details.outcome, "error")
    }
  })
}

test("actual retry-failed ignores running incidental work but preserves a running review gate", () => {
  assert.equal(
    invoke(
      "retry-failed",
      [failedReview],
      [{ ...issueMapping, status: "running" }],
    ).details.outcome,
    "retry-failed",
  )
  assert.equal(
    invoke(
      "retry-failed",
      [failedReview],
      [{ ...failedReview, id: "wf-10", status: "running" }],
    ).isError,
    true,
  )
})

test("actual complete-auto selects completed review evidence rather than an incidental failure", () => {
  const result = invoke("complete-auto", [
    { ...failedReview, status: "completed" },
    { ...issueMapping, status: "failed" },
  ])
  assert.equal(result.details.outcome, "complete-auto")
  assert.equal(result.details.priorAuditId, "wf-6")
})

test("actual continuation counts review passes, not incidental completed workflows", () => {
  const result = invoke("continue", [
    {
      ...failedReview,
      id: "wf-1",
      status: "completed",
      startedAt: 11,
      finishedAt: 19,
    },
    { ...failedReview, status: "completed" },
    ...Array.from({ length: 5 }, (_, index) => ({
      ...issueMapping,
      id: `wf-${index + 10}`,
    })),
  ])
  assert.equal(result.details.outcome, "continued")
  assert.equal(result.details.completedPasses, 2)
  assert.equal(result.details.priorAuditId, "wf-6")
})

test("admission boundary and matching bare repository remain supported", () => {
  assert.equal(
    invoke("retry-failed", [
      {
        ...failedReview,
        startedAt: 20,
        label: "Review PR274 for dataclique/yielduck",
      },
    ]).details.outcome,
    "retry-failed",
  )
  assert.equal(
    invoke(
      "retry-failed",
      [failedReview],
      [{ ...failedReview, id: "wf-1", startedAt: 19, status: "running" }],
    ).details.outcome,
    "retry-failed",
  )
})

test("managed cancellation recovery belongs to the selected review, not incidental work", () => {
  const automatic: gate.ReviewDutyState = {
    ...job,
    kind: "auto",
    continuation: "fix-re-review",
  }
  const cancelledReview = {
    ...failedReview,
    status: "cancelled",
    outcome: audit.MANAGED_RELOAD_WORKFLOW_CANCELLATION,
  }
  assert.equal(
    invoke("retry-failed", [cancelledReview, issueMapping], [], automatic)
      .details.recoveredAuditId,
    "wf-6",
  )
  assert.equal(
    invoke(
      "retry-failed",
      [
        { ...failedReview, status: "completed" },
        {
          ...issueMapping,
          status: "cancelled",
          outcome: audit.MANAGED_RELOAD_WORKFLOW_CANCELLATION,
        },
      ],
      [],
      automatic,
    ).isError,
    true,
  )
})

test("actual release-unusable preserves completed children inside a failed review wrapper", () => {
  assert.equal(invoke("release-unusable", [failedReview]).isError, true)
})

test("actual release-unusable does not confuse incidental output with review evidence", () => {
  assert.equal(
    invoke("release-unusable", [issueMapping]).details.outcome,
    "released-unusable",
  )
})
