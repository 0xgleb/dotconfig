import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const questions = readFileSync(new URL("../pi/extensions/questions/index.ts", import.meta.url), "utf8");
const workflows = readFileSync(new URL("../pi/extensions/classified-workflows/index.ts", import.meta.url), "utf8");

test("questions use a real picker instead of a non-focusable below-editor widget", () => {
  assert.match(questions, /ctx\.ui\.select\("Pending questions/);
  assert.doesNotMatch(questions, /placement: "belowEditor"/);
  assert.match(questions, /setWidget\(QUESTION_STATUS_KEY, undefined\)/);
});

test("a submitted question answer unpauses and resumes the waiting agent", () => {
  assert.match(questions, /pi\.events\.emit\(QUESTION_RESOLVED_EVENT, resolution\)/);
  assert.match(questions, /The user answered q\$\{question\.id\}/);
  assert.match(questions, /triggerTurn: true, deliverAs: "followUp"/);
  assert.match(workflows, /pi\.events\.on\(QUESTION_RESOLVED_EVENT/);
  assert.match(workflows, /setContinuationPaused\(false, latestCtx\)/);
});
