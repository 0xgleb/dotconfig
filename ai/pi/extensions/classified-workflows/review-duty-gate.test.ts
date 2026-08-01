import assert from "node:assert/strict";
import test from "node:test";
import {
  REVIEW_DUTY_STATE_ENTRY,
  beginReviewDuty,
  emptyReviewDutyState,
  startReviewWorkflow,
  reportReviewDuty,
  restoreReviewDutyState,
  reviewWorkflowBlockReason,
} from "./review-duty-gate.ts";

const job = {
  repository: "st0x.liquidity",
  pullRequest: 1101,
  kind: "own" as const,
};

const verdictQuestion = {
  id: 7,
  status: "pending" as const,
  question:
    "PR #1101 assessment: merge-ready after verification; verified finding status: clean.",
  options: [
    { label: "Approve" },
    { label: "Request changes" },
    { label: "Inspect first" },
  ],
};

test("the dedicated reviewer cannot run a workflow before beginning a typed job", () => {
  assert.match(
    reviewWorkflowBlockReason("st0x-review-duty", emptyReviewDutyState) ?? "",
    /review_duty begin/i,
  );
  assert.equal(
    reviewWorkflowBlockReason("ordinary-session", emptyReviewDutyState),
    undefined,
  );
});

test("a completed review workflow must relay a verdict question before another job", () => {
  const active = beginReviewDuty(emptyReviewDutyState, job, 10);
  assert.equal(active.ok, true);
  if (!active.ok) return;
  assert.equal(reviewWorkflowBlockReason("st0x-review-duty", active.state), undefined);

  const awaiting = startReviewWorkflow(active.state, 20);
  assert.equal(awaiting.phase, "awaiting_report");
  assert.match(
    reviewWorkflowBlockReason("st0x-review-duty", awaiting) ?? "",
    /persisted and linked/i,
  );
  const next = beginReviewDuty(awaiting, { ...job, pullRequest: 1102 }, 30);
  assert.deepEqual(next, {
    ok: false,
    error: "PR #1101 still requires a persisted and relayed verdict question",
  });
});

test("reporting fails until the exact bounded verdict question is linked", () => {
  const active = beginReviewDuty(emptyReviewDutyState, job, 10);
  assert.equal(active.ok, true);
  if (!active.ok) return;
  const awaiting = startReviewWorkflow(active.state, 20);

  assert.match(
    reportReviewDuty(awaiting, verdictQuestion, false, 30).error ?? "",
    /not linked/i,
  );
  assert.match(
    reportReviewDuty(
      awaiting,
      { ...verdictQuestion, options: [{ label: "Approve" }] },
      true,
      30,
    ).error ?? "",
    /three verdict options/i,
  );
  assert.match(
    reportReviewDuty(
      awaiting,
      { ...verdictQuestion, question: "PR #999 is clean" },
      true,
      30,
    ).error ?? "",
    /PR #1101/i,
  );

  const reported = reportReviewDuty(awaiting, verdictQuestion, true, 30);
  assert.equal(reported.ok, true);
  if (!reported.ok) return;
  assert.deepEqual(reported.state, {
    phase: "idle",
    lastReported: {
      ...job,
      questionId: 7,
      reportedAt: 30,
    },
  });
});

test("review duty state survives reload defensively", () => {
  const active = beginReviewDuty(emptyReviewDutyState, job, 10);
  assert.equal(active.ok, true);
  if (!active.ok) return;
  assert.deepEqual(
    restoreReviewDutyState([
      {
        type: "custom",
        customType: REVIEW_DUTY_STATE_ENTRY,
        data: active.state,
      },
    ]),
    active.state,
  );
  assert.deepEqual(
    restoreReviewDutyState([
      {
        type: "custom",
        customType: REVIEW_DUTY_STATE_ENTRY,
        data: { phase: "active", pullRequest: -1 },
      },
    ]),
    emptyReviewDutyState,
  );
});
