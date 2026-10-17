import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { stripTypeScriptTypes } from "node:module"
import test from "node:test"
import {
  runtimeReviewDutyContext,
  completeAutoReviewDuty,
  continueReviewDuty,
  reviewDutyJobAllowed,
  type ReviewDutyState,
} from "./review-duty-gate.ts"
import { latestCompletedWorkflowAfter } from "./workflow-audit.ts"
import {
  selectReviewWorkflowAudit,
  selectReviewContinuationAudit,
  workflowMatchesReviewJob,
} from "./review-workflow.ts"

const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8")
const job: ReviewDutyState = {
  phase: "awaiting_report",
  repository: "dataclique/yielduck",
  pullRequest: 274,
  kind: "own",
  startedAt: 10,
  completedAt: 20,
}

test("actual classifier boundary carries the current gate after a different PR and rejects request-supplied gate identity", async () => {
  const start = source.indexOf("  const classifyWithActivity =")
  const end = source.indexOf("  const formatDuration =", start)
  assert.ok(start >= 0 && end > start)
  const captured: Array<Record<string, unknown>> = []
  const harness = new Function(
    "dependencies",
    `
    const { runtimeReviewDutyContext, classify } = dependencies;
    let reviewDutyState = { phase: "idle" };
    const isRecord = value => typeof value === "object" && value !== null && !Array.isArray(value);
    const runtimeProactiveHandoverContext = () => undefined;
    const runtimeProjectPolicyContext = () => undefined;
    const runtimeClassificationProjectContexts = () => ({});
    const reviewDutySessionName = () => "dataclique-review-duty";
    const pi = { events: { emit: () => {} } };
    const ACTIVITY_PHASE_EVENT = "activity";
    ${stripTypeScriptTypes(source.slice(start, end))}
    return { classifyWithActivity, setState: state => { reviewDutyState = state; } };
  `,
  )({
    runtimeReviewDutyContext,
    classify: async (request: Record<string, unknown>) => {
      captured.push(request)
      return { verdict: "allow", reason: "test capture only" }
    },
  })
  const ctx = {
    cwd: process.cwd(),
    getContextUsage: () => undefined,
    getSystemPrompt: () => "",
  }
  harness.setState({
    ...job,
    repository: "dataclique/event-sorcery-hs",
    pullRequest: 5,
  })
  await harness.classifyWithActivity(
    { boundary: "spawn", subject: {}, executionEvidence: [] },
    ctx,
  )
  harness.setState(job)
  for (const boundary of ["spawn", "action", "result", "return"]) {
    await harness.classifyWithActivity(
      {
        boundary,
        subject: {},
        executionEvidence: ["old summary says event-sorcery #5"],
        runtimeReviewDutyContext: { gateRequired: false },
      },
      ctx,
    )
    assert.deepEqual(captured.at(-1)?.runtimeReviewDutyContext, {
      sessionName: "dataclique-review-duty",
      gateRequired: true,
      gateState: job,
    })
  }
})

for (const action of ["complete-auto", "continue"] as const)
  test(`actual ${action} rejects completed wrappers with no usable completed child`, () => {
    const start = source.indexOf(`      if (request.action === "${action}") {`)
    const nextAction = action === "continue" ? "complete-auto" : "retry-failed"
    const end = source.indexOf(
      `      if (request.action === "${nextAction}") {`,
      start,
    )
    assert.ok(start >= 0 && end > start)
    const invoke = new Function(
      "dependencies",
      `
    const { completeAutoReviewDuty, continueReviewDuty, reviewDutyJobAllowed, latestCompletedWorkflowAfter, selectReviewWorkflowAudit, selectReviewContinuationAudit, workflowMatchesReviewJob, children, job, action } = dependencies;
    const request = { action };
    const ctx = {};
    const refreshWorkflowAudits = () => {};
    const dutySessionName = "dataclique-review-duty";
    let reviewDutyState = job;
    const workflowAudits = { workflows: [{ id: "wf-5", label: "Review PR274", status: "completed", startedAt: 21, finishedAt: 30, children }] };
    const backgroundWorkflows = new Map();
    const pi = { appendEntry: () => {} };
    const REVIEW_DUTY_STATE_ENTRY = "review-duty";
    ${stripTypeScriptTypes(`const run = () => {\n${source.slice(start, end)}\n}`)}
    return run();
  `,
    )
    const run = (
      children: readonly { status: string; outputCharacters: number }[],
    ) =>
      invoke({
        action,
        completeAutoReviewDuty,
        continueReviewDuty,
        reviewDutyJobAllowed,
        latestCompletedWorkflowAfter,
        selectReviewWorkflowAudit,
        selectReviewContinuationAudit,
        workflowMatchesReviewJob,
        children,
        job,
      })
    for (const children of [
      [],
      [{ status: "completed", outputCharacters: 0 }],
      Array.from({ length: 16 }, () => ({
        status: "blocked",
        outputCharacters: 0,
      })),
      [{ status: "failed", outputCharacters: 100 }],
    ]) {
      assert.equal(run(children).isError, true)
    }
    assert.equal(
      run([
        { status: "completed", outputCharacters: 100 },
        { status: "blocked", outputCharacters: 0 },
      ]).details.outcome,
      action === "continue" ? "continued" : "complete-auto",
    )
  })
