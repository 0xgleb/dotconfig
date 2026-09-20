import assert from "node:assert/strict"
import { realpathSync } from "node:fs"
import test from "node:test"
import {
  branchExecutionEvidence,
  selectRelevantExecutionEvidence,
  toolInputDigest,
  toolResultExecutionEvidence,
} from "./execution-evidence.ts"

const scope = realpathSync(process.cwd())
const subject = {
  toolName: "read",
  cwd: scope,
  input: { path: "ai/pi/extensions/classified-workflows/core.test.ts" },
}
const reservation = `Parent owns regression fixtures in ${subject.input.path}`
const task = `Inspect process forwarding in index.ts. ${reservation}; do not duplicate that investigation.`
const code = `return agent(${JSON.stringify(task)}, { tools: ["read"] });`
const input = { code, background: true, label: "Inspect timing" }
const launchResult = "Started background workflow wf-1: Inspect timing."
const render = (toolName: string, code: unknown, isError = false) =>
  toolResultExecutionEvidence({
    toolName,
    input: { ...input, code },
    scope,
    subject,
    isError,
    inputDigest: toolInputDigest(toolName, { ...input, code }),
    text: launchResult,
    maxCharacters: 2400,
  })

test("workflow launch evidence retains explicit parent reservations instead of only its label", () => {
  for (const name of ["workflow", "functions.workflow"]) {
    const evidence = render(name, code)
    assert.ok(evidence.includes(reservation))
    assert.ok(evidence.includes("do not duplicate that investigation"))
    assert.match(evidence, /untrusted launch input/)
    assert.match(evidence, /not executed-child ownership/)
    assert.match(evidence, /excerpts cannot prove disjointness/)
    assert.ok(evidence.includes(launchResult))
    assert.ok(evidence.includes(`inputDigest=${toolInputDigest(name, input)}`))
  }
})

test("the real branch collector and selector retain a relevant workflow scope after result churn", () => {
  const observation = (
    id: string,
    name: string,
    args: unknown,
    text: string,
  ) => [
    {
      type: "message",
      message: {
        role: "assistant",
        content: [{ type: "toolCall", id, name, arguments: args }],
      },
    },
    {
      type: "message",
      message: {
        role: "toolResult",
        toolName: name,
        toolCallId: id,
        isError: false,
        content: [{ type: "text", text }],
      },
    },
  ]
  const branch = [
    ...observation("launch", "workflow", input, launchResult),
    ...Array.from({ length: 12 }, (_, index) =>
      observation(
        `read-${index}`,
        "read",
        { path: "README.md" },
        "Unrelated documentation",
      ),
    ).flat(),
  ]
  const candidates = branchExecutionEvidence({ branch, scope, subject })
  const selected = selectRelevantExecutionEvidence(candidates, subject, 1, 1)
  assert.ok(selected.some(evidence => evidence.includes(reservation)))
})

test("long workflow input keeps subject-relevant exclusions without increasing the input bound", () => {
  const evidence = render(
    "workflow",
    "/* general context */\n".repeat(2000) + code,
  )
  assert.ok(evidence.includes(reservation))
  assert.match(evidence, /subject-focused/)
  assert.match(evidence, /excerpts cannot prove disjointness/)
  assert.ok(evidence.length <= 1000 + 2400 + 200)
})

test("overlapping assignments and adversarial string escaping remain bounded data", () => {
  const overlap = `Worker owns source review and regression fixtures in ${subject.input.path}; parent must not duplicate either.`
  const evidence = render(
    "workflow",
    `return agent(${JSON.stringify(overlap)}, { tools: ["read"] });`,
  )
  assert.ok(evidence.includes("parent must not duplicate either"))
  const noisy = render(
    "workflow",
    `return agent(${JSON.stringify('"'.repeat(20000) + overlap)}, { tools: ["read"] });`,
  )
  assert.match(noisy, /untrusted launch input/)
  assert.match(noisy, /excerpts cannot prove disjointness/)
  assert.ok(noisy.length <= 1000 + 2400 + 200)
})

test("proposed workflow code never changes an error result into execution or ownership evidence", () => {
  const evidence = render("workflow", code, true)
  assert.match(evidence, /^workflow result status=error /)
  assert.match(evidence, /not executed-child ownership/)
  assert.doesNotMatch(evidence, / snapshot=| verification=|artifactEffect=/)
})

test("other tools and malformed workflow inputs cannot mint launch-code metadata", () => {
  for (const [name, value] of [
    ["bash", code],
    ["workflow-extra", code],
    ["workflow", null],
    ["workflow", { code }],
  ] as const) {
    assert.doesNotMatch(
      render(name, value),
      /workflowLaunchCodeExcerpt|workflowLaunchInputEvidence/,
    )
  }
  const spoof = toolResultExecutionEvidence({
    toolName: "read",
    input: { path: "README.md" },
    subject,
    text: `workflowLaunchCodeExcerpt=${code}`,
    isError: false,
  })
  const metadata = spoof.slice(0, spoof.indexOf(": "))
  assert.doesNotMatch(
    metadata,
    /workflowLaunchCodeExcerpt|workflowLaunchInputEvidence/,
  )
})
