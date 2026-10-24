import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { visibleWidth } from "@earendil-works/pi-tui"
import { framedChromeInset } from "../shared/chrome.ts"
import {
  activeWorkflowLines,
  activeWorkflowPanelLines,
  backgroundWorkflowStartedText,
  workflowHistoryText,
  workflowProgressText,
  workflowStructuredResultTableLines,
  workflowStructuredResultValue,
  type WorkflowUiItem,
} from "./workflow-ui.ts"

const extensionSource = readFileSync(
  new URL("./index.ts", import.meta.url),
  "utf8",
)

const workflows: WorkflowUiItem[] = [
  {
    id: "wf-1",
    label: "inspect",
    status: "running",
    elapsed: "12s",
    limits: "max 2 children · 2 parallel · 1k token budget",
    progress: "child 2 · sonnet · tool read started",
    phase: "verify findings",
    children: [
      {
        index: 2,
        task: "Verify the candidate finding against the changed source",
        model: "sonnet",
        tools: "read, grep",
        status: "running",
        elapsed: "8s",
        latest: "tool read started",
      },
    ],
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
]

test("background start guidance keeps delegated work out of the foreground", () => {
  const text = backgroundWorkflowStartedText("wf-4", "secondary review")
  assert.match(text, /owns the delegated task/i)
  assert.match(text, /keep the foreground focused/i)
  assert.match(text, /unless the workflow fails/i)
})

test("workflow progress names purpose, phase, observed counts, and latest evidence", () => {
  assert.equal(
    workflowProgressText({
      purpose: "review example PR #451",
      phase: "verify findings",
      started: 10,
      running: 2,
      completed: 7,
      failed: 1,
      maxAgents: 16,
      latest: "child 10 · model reasoning",
    }),
    "review example PR #451 · phase verify findings · progress 8 settled / 2 running / 10 started (7 ok, 1 failed; max 16/phase) · latest child 10 · model reasoning",
  )
})

test("persistent workflow UI contains only active work", () => {
  assert.deepEqual(activeWorkflowLines(workflows), [
    "WORKFLOWS · 1 active · /workflows for history",
    "● wf-1 · inspect · running 12s",
    "↳ child 2 · sonnet · tool read started · max 2 children · 2 parallel · 1k token budget",
  ])
  assert.deepEqual(activeWorkflowLines(workflows.slice(1)), [])
})

test("active workflow HUD is framed on the same pane-relative columns as tasks", () => {
  for (const width of [40, 80, 120, 180]) {
    const lines = activeWorkflowPanelLines(workflows, width)
    assert.equal(lines.length, 6)
    assert.equal(
      lines.every(line => visibleWidth(line) === width),
      true,
    )
    assert.equal(
      lines.every(line => line.search(/\S/u) === framedChromeInset(width)),
      true,
    )
    assert.match(lines[0] ?? "", /^\s*╭─ WORKFLOWS/u)
    assert.match(lines[1] ?? "", /^\s*│  ● wf-1/u)
    assert.match(lines[2] ?? "", /^\s*│  ↳ phase verify findings/u)
    assert.match(lines[3] ?? "", /child 02.*running.*sonnet/u)
    assert.match(lines[4] ?? "", /task.*Verify the candidate/u)
    assert.match(lines[5] ?? "", /now.*tool read started/u)
  }
})

test("active workflow HUD mounts above the prompt", () => {
  const renderPanel = extensionSource.slice(
    extensionSource.indexOf("const renderWorkflowPanel"),
    extensionSource.indexOf("const showWorkflowMessage"),
  )
  assert.match(
    renderPanel,
    /new WorkflowHudComponent\(workflowUiItems, theme\)/,
  )
  assert.match(renderPanel, /placement: "aboveEditor"/)
  assert.doesNotMatch(renderPanel, /placement: "belowEditor"/)
})

test("background workflows surface named phase and bounded log progress", () => {
  const start = extensionSource.slice(
    extensionSource.indexOf("const startBackgroundWorkflow"),
    extensionSource.indexOf("const showGoalMessage"),
  )
  assert.match(start, /phase: (?:\(title\)|title).*workflow\.progress/s)
  assert.match(start, /log: (?:\(message\)|message).*workflow\.progress/s)
  assert.match(
    start,
    /workflow\.liveProgress\.latest = `update · \$\{message\}`/,
  )
  assert.match(start, /observeLiveWorkflowChild/)
  assert.match(start, /liveWorkflowProgressText/)
})

test("JSON workflow strings are parsed once into structured display data", () => {
  assert.deepEqual(
    workflowStructuredResultValue('[{"status":"completed","usageTokens":12}]'),
    [{ status: "completed", usageTokens: 12 }],
  )
  assert.equal(workflowStructuredResultValue("ordinary prose"), undefined)
  assert.equal(workflowStructuredResultValue("42"), undefined)
})

test("structured workflow results render as a bounded dataframe instead of raw JSON", () => {
  const result = [
    {
      status: "completed",
      output:
        "Findings for merge PR #19:\n1. Missing quality commands\n2. WDK mismatch",
      usageTokens: 50_824,
      diagnostic:
        "Child action blocked twice; protected metadata was withheld.",
    },
    {
      status: "completed",
      output: "No additional findings",
      usageTokens: 49_303,
      diagnostic: "",
    },
  ]
  const lines = workflowStructuredResultTableLines(result, 120)

  assert.match(lines[0] ?? "", /^╭/u)
  assert.match(lines[1] ?? "", /#.*status.*usageTokens.*output.*diagnostic/u)
  assert.ok(
    lines.some(line => /1.*completed.*50,824.*Findings for merge/u.test(line)),
  )
  assert.ok(
    lines.some(line =>
      /2.*completed.*49,303.*No additional findings/u.test(line),
    ),
  )
  assert.ok(lines.every(line => visibleWidth(line) <= 120))
  assert.doesNotMatch(lines.join("\n"), /"status"|\\n|^\s*[\[{]/m)
})

test("narrow structured workflow results stay readable without JSON syntax", () => {
  const lines = workflowStructuredResultTableLines(
    [{ status: "completed", output: "one\ntwo", usageTokens: 500 }],
    36,
  )
  assert.ok(lines.every(line => visibleWidth(line) <= 36))
  assert.match(lines.join("\n"), /1.*completed.*500/u)
  assert.doesNotMatch(lines.join("\n"), /"status"|\\n|[{}\[\]]/u)
})

test("workflow completion renderers hide raw JSON while preserving model-facing output", () => {
  assert.match(
    extensionSource,
    /registerMessageRenderer\(WORKFLOW_MESSAGE[\s\S]*?structuredWorkflowResultComponent/,
  )
  assert.match(
    extensionSource,
    /renderResult\(result, _options, theme\)[\s\S]*?structuredWorkflowResultComponent/,
  )
  assert.match(
    extensionSource,
    /structuredResult: workflowStructuredResultValue\(result\)/,
  )
  assert.match(
    extensionSource,
    /showWorkflowMessage\(`\$\{summary\}\\nResult:\\n\$\{workflow\.output\}`/,
  )
})

test("workflow history explains terminal outcomes", () => {
  const history = workflowHistoryText(workflows)
  assert.match(history, /wf-1.*running.*inspect/i)
  assert.match(history, /wf-2.*completed.*review/i)
  assert.match(history, /No findings/)
  assert.match(history, /wf-3.*failed.*probe/i)
  assert.match(history, /Timed out/)
})
