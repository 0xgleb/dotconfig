import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { chromeInset } from "../shared/chrome.ts";
import {
  activeWorkflowLines,
  activeWorkflowPanelLines,
  backgroundWorkflowStartedText,
  workflowHistoryText,
  workflowProgressText,
  type WorkflowUiItem,
} from "./workflow-ui.ts";

const extensionSource = readFileSync(new URL("./index.ts", import.meta.url), "utf8")

const workflows: WorkflowUiItem[] = [
  {
    id: "wf-1",
    label: "inspect",
    status: "running",
    elapsed: "12s",
    limits: "max 2 children · 2 parallel · 1k token budget",
    progress: "child 2 · sonnet · tool read started",
  },
  {
    id: "wf-2",
    label: "review",
    status: "completed",
    elapsed: "31s",
    limits: "max 3 children · 2 parallel · 2k token budget",
    outcome: "No findings",
  },
  {
    id: "wf-3",
    label: "probe",
    status: "failed",
    elapsed: "4s",
    limits: "max 1 child · 1 parallel · 1k token budget",
    outcome: "Timed out",
  },
];

test("background start guidance keeps delegated work out of the foreground", () => {
  const text = backgroundWorkflowStartedText("wf-4", "secondary review");
  assert.match(text, /owns the delegated task/i);
  assert.match(text, /keep the foreground focused/i);
  assert.match(text, /unless the workflow fails/i);
});

test("workflow progress names purpose, phase, observed counts, and latest evidence", () => {
  assert.equal(
    workflowProgressText({
      purpose: "review moneymentum PR #451",
      phase: "verify findings",
      started: 10,
      running: 2,
      completed: 7,
      failed: 1,
      maxAgents: 16,
      latest: "child 10 · model reasoning",
    }),
    "review moneymentum PR #451 · phase verify findings · progress 8 settled / 2 running / 10 started (7 ok, 1 failed; max 16/phase) · latest child 10 · model reasoning",
  );
});

test("persistent workflow UI contains only active work", () => {
  assert.deepEqual(activeWorkflowLines(workflows), [
    "WORKFLOWS · 1 active · /workflows for history",
    "● wf-1 · inspect · running 12s",
    "↳ child 2 · sonnet · tool read started · max 2 children · 2 parallel · 1k token budget",
  ]);
  assert.deepEqual(activeWorkflowLines(workflows.slice(1)), []);
});

test("active workflow panel shares the pane-relative chrome gutter", () => {
  for (const width of [40, 80, 120, 180]) {
    const lines = activeWorkflowPanelLines(workflows, width);
    assert.equal(lines.length, 3);
    assert.equal(lines.every((line) => visibleWidth(line) === width), true);
    assert.equal(
      lines.every((line) => line.search(/\S/u) === chromeInset(width)),
      true,
    );
  }
});

test("background workflows surface named phase and bounded log progress", () => {
  const start = extensionSource.slice(
    extensionSource.indexOf("const startBackgroundWorkflow"),
    extensionSource.indexOf("const showGoalMessage"),
  )
  assert.match(start, /phase: \(title\).*workflow\.progress/s)
  assert.match(start, /log: \(message\).*workflow\.progress/s)
  assert.match(start, /workflow\.liveProgress\.latest = `update · \$\{message\}`/)
  assert.match(start, /observeLiveWorkflowChild/)
  assert.match(start, /liveWorkflowProgressText/)
})

test("workflow history explains terminal outcomes", () => {
  const history = workflowHistoryText(workflows);
  assert.match(history, /wf-1.*running.*inspect/i);
  assert.match(history, /wf-2.*completed.*review/i);
  assert.match(history, /No findings/);
  assert.match(history, /wf-3.*failed.*probe/i);
  assert.match(history, /Timed out/);
});
