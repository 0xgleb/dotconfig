import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const todo = readFileSync(new URL("../pi/extensions/todo/index.ts", import.meta.url), "utf8");
const questions = readFileSync(new URL("../pi/extensions/questions/index.ts", import.meta.url), "utf8");

test("blocked todo triage is explicit focused UI with bounded actions", () => {
  assert.match(todo, /registerCommand\("blocked"/);
  assert.match(todo, /Blocked todos · select one to triage/);
  assert.match(todo, /BLOCKED #\$\{todo\.id\}/);
  for (const label of ["Unblock", "Mark resolved", "Edit blocker", "Create pending question"]) {
    assert.match(todo, new RegExp(label));
  }
  assert.match(todo, /overlay: true/);
  assert.doesNotMatch(todo, /pi\.on\("agent_settled"[\s\S]*chooseBlockedAction/);
});

test("blocked todo questions queue passively through the questions extension", () => {
  assert.match(todo, /pi\.events\.emit\(QUESTION_ASK_EVENT, request\)/);
  assert.match(todo, /Blocked todo #\$\{todo\.id\}/);
  assert.match(questions, /pi\.events\.on\(QUESTION_ASK_EVENT/);
  assert.match(questions, /Open \/questions to answer/);
  const listener = questions.slice(
    questions.indexOf("pi.events.on(QUESTION_ASK_EVENT"),
    questions.indexOf('pi.on("before_agent_start"'),
  );
  assert.doesNotMatch(listener, /showQuestionDialog/);
});
