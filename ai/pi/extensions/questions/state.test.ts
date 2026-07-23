import assert from "node:assert/strict";
import test from "node:test";
import { applyQuestionAction, decodeQuestionState, emptyQuestionState, pendingQuestions } from "./state.ts";
import { pendingQuestionContext, questionListText, questionWidgetLines } from "./presentation.ts";

test("questions remain pending until explicitly resolved", () => {
  const asked = applyQuestionAction(emptyQuestionState, {
    action: "ask",
    question: "Should production operators deploy directly?",
    header: "Deployment",
    guess: "No; circuit-break only.",
    options: [
      { label: "No", description: "Circuit-break only" },
      { label: "Yes", description: "Allow direct deploys" },
    ],
  });
  assert.equal(pendingQuestions(asked).length, 1);
  assert.match(questionWidgetLines(asked).join("\n"), /ACTION REQUIRED.*1 decision pending/i);
  assert.match(questionWidgetLines(asked).join("\n"), /\/questions.*↑\/↓ select.*enter to answer/i);
  assert.doesNotMatch(questionWidgetLines(asked).join("\n"), /Guess:/);
  assert.match(pendingQuestionContext(asked) ?? "", /Continue independent work/);
  assert.equal(pendingQuestions(asked)[0]?.header, "Deployment");
  assert.deepEqual(pendingQuestions(asked)[0]?.options?.map(({ label }) => label), ["No", "Yes"]);

  const resolved = applyQuestionAction(asked, {
    action: "resolve",
    id: 1,
    answer: "Confirmed: circuit-break only.",
  });
  assert.equal(pendingQuestions(resolved).length, 0);
  assert.match(questionListText(resolved), /Confirmed: circuit-break only/);
});

test("pending queue renders selectable question identifiers below the editor", () => {
  const first = applyQuestionAction(emptyQuestionState, { action: "ask", question: "First decision?" });
  const second = applyQuestionAction(first, { action: "ask", question: "Second decision?" });
  const lines = questionWidgetLines(second).join("\n");
  assert.match(lines, /q1\s+First decision/);
  assert.match(lines, /q2\s+Second decision/);
  assert.match(lines, /↑\/↓ select/);
});

test("question state decoder rejects malformed partial state", () => {
  const state = applyQuestionAction(emptyQuestionState, { action: "ask", question: "Need input?" });
  assert.deepEqual(decodeQuestionState(state), state);
  assert.equal(decodeQuestionState({ questions: [{ id: 1, status: "resolved", question: "Q" }], nextId: 2 }), undefined);
});

test("clearing resolved questions preserves pending decisions", () => {
  const first = applyQuestionAction(emptyQuestionState, { action: "ask", question: "First?" });
  const second = applyQuestionAction(first, { action: "ask", question: "Second?" });
  const resolved = applyQuestionAction(second, { action: "resolve", id: 1, answer: "Yes" });
  const cleared = applyQuestionAction(resolved, { action: "clear_resolved" });
  assert.deepEqual(pendingQuestions(cleared).map(({ id }) => id), [2]);
});
