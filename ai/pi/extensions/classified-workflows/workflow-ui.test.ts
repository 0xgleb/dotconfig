import assert from "node:assert/strict";
import test from "node:test";
import {
  activeWorkflowLines,
  backgroundWorkflowStartedText,
  workflowHistoryText,
  type WorkflowUiItem,
} from "./workflow-ui.ts";

const workflows: WorkflowUiItem[] = [
  { id: "wf-1", label: "inspect", status: "running", elapsed: "12s", limits: "2a/2c/1000t" },
  { id: "wf-2", label: "review", status: "completed", elapsed: "31s", limits: "3a/2c/2000t", outcome: "No findings" },
  { id: "wf-3", label: "probe", status: "failed", elapsed: "4s", limits: "1a/1c/1000t", outcome: "Timed out" },
];

test("background start guidance keeps delegated work out of the foreground", () => {
  const text = backgroundWorkflowStartedText("wf-4", "secondary review");
  assert.match(text, /owns the delegated task/i);
  assert.match(text, /keep the foreground focused/i);
  assert.match(text, /unless the workflow fails/i);
});

test("persistent workflow UI contains only active work", () => {
  assert.deepEqual(activeWorkflowLines(workflows), [
    "Workflows: 1 active · /workflows for history",
    "● wf-1 · inspect · 12s · 2a/2c/1000t",
  ]);
  assert.deepEqual(activeWorkflowLines(workflows.slice(1)), []);
});

test("workflow history explains terminal outcomes", () => {
  const history = workflowHistoryText(workflows);
  assert.match(history, /wf-1.*running.*inspect/i);
  assert.match(history, /wf-2.*completed.*review/i);
  assert.match(history, /No findings/);
  assert.match(history, /wf-3.*failed.*probe/i);
  assert.match(history, /Timed out/);
});
