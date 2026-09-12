import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { currentHumanContinuationDisprovesSpecScopeBlock } from "./intent-context.ts"

// Exercise the actual early admission branch without loading the full SDK host.
test("retired stack commands cannot override a classifier block", () => {
  const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8")
  const start = source.indexOf('    if (decision.verdict === "block") {')
  const end = source.indexOf(
    '      if (\n        event.toolName === "workflow"',
    start,
  )
  assert.ok(start >= 0 && end > start)
  const run = new Function(
    "decision",
    "event",
    "ctx",
    "currentHumanContinuationDisprovesSpecScopeBlock",
    "currentHumanResumeDisprovesDeferredGraphiteMoveBlock",
    "persistReviewWorkflowStart",
    `${source.slice(start, end)} } return "blocked"`,
  )
  const branch = [
    {
      type: "custom",
      customType: "todo.state",
      data: {
        todos: [
          { id: 1, text: "Repair Graphite topology", status: "in_progress" },
        ],
      },
    },
    {
      type: "message",
      message: { role: "user", content: "Resume all work now." },
    },
  ]
  for (const reason of [
    "This topology repair was deferred for later.",
    "The command may expose credentials.",
    "Publication is not authorized.",
  ]) {
    let admitted = 0
    const result = run(
      { verdict: "block", reason },
      {
        toolName: "bash",
        input: {
          command:
            "gt move --source fix/example --onto master --no-interactive",
        },
      },
      { cwd: "/repo", sessionManager: { getBranch: () => branch } },
      currentHumanContinuationDisprovesSpecScopeBlock,
      () => true,
      () => {
        admitted += 1
      },
    )
    assert.equal(result, "blocked", reason)
    assert.equal(admitted, 0)
  }
})
