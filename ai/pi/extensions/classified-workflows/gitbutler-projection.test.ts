import assert from "node:assert/strict"
import test from "node:test"
import {
  branchExecutionEvidence,
  selectRelevantExecutionEvidence,
  toolResultExecutionEvidence,
} from "./execution-evidence.ts"

const scope = "/workspace/project"
const projectionCommand =
  "but status --json | from json | get uncommittedChanges | to json"
const subject = {
  toolName: "bash",
  cwd: scope,
  input: { command: "but unapply feature/recovery" },
}
const evidence = (
  command: string,
  text: string,
  cwd = scope,
  isError = false,
) =>
  branchExecutionEvidence({
    scope: cwd,
    subject,
    branch: [
      {
        type: "message",
        message: {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "call",
              name: "bash",
              arguments: { command },
            },
          ],
        },
      },
      {
        type: "message",
        message: {
          role: "toolResult",
          toolCallId: "call",
          toolName: "bash",
          isError,
          content: [{ type: "text", text }],
        },
      },
    ],
  })[0]!
const churn = Array.from(
  { length: 12 },
  (_, index) => `read result status=success: unrelated file ${index}`,
)
const marker =
  /^bash result status=success[^:]*\bsnapshot=gitbutler-uncommitted\b/

test("exact managed-changes projection survives churn without replacing full topology", () => {
  const topology = evidence(
    "but status --json",
    '{"branches":["feature/recovery"],"uncommittedChanges":["dirty.ts"]}',
  )
  const projection = evidence(projectionCommand, "[]")
  assert.match(projection, marker)
  const selected = selectRelevantExecutionEvidence(
    [topology, projection, ...churn],
    subject,
    2,
    0,
  )
  assert.ok(selected.includes(projection))
  assert.ok(
    selected.includes(topology),
    "partial observation must not erase topology",
  )
  assert.ok(selected.indexOf(topology) < selected.indexOf(projection))
})

test("new projections replace old projections, and a later full status retires the older partial fact", () => {
  const prior = evidence(projectionCommand, '["old.ts"]')
  const current = evidence(projectionCommand, "[]")
  const latest = evidence(
    "but status --json",
    '{"uncommittedChanges":["new.ts"]}',
  )
  const partial = selectRelevantExecutionEvidence(
    [prior, current, ...churn],
    subject,
    2,
    0,
  )
  assert.ok(partial.includes(current))
  assert.ok(!partial.includes(prior))
  const full = selectRelevantExecutionEvidence(
    [prior, current, latest, ...churn],
    subject,
    2,
    0,
  )
  assert.ok(full.includes(latest))
  assert.ok(!full.includes(current))
})

test("projection facts require matching project scope", () => {
  const current = evidence(projectionCommand, "[]")
  const other = evidence(projectionCommand, "[]", "/workspace/other")
  assert.deepEqual(selectRelevantExecutionEvidence([current, other], subject), [
    current,
  ])
  assert.deepEqual(
    selectRelevantExecutionEvidence([current], {
      toolName: "bash",
      input: subject.input,
    }),
    [],
  )
  const unscoped = toolResultExecutionEvidence({
    toolName: "bash",
    input: { command: projectionCommand },
    text: "[]",
    isError: false,
    subject,
  })
  assert.doesNotMatch(unscoped, marker)
})

test("unknown pipelines, failed commands and output text cannot assert the projection marker", () => {
  for (const command of [
    `${projectionCommand} | length`,
    `${projectionCommand}; pwd`,
    projectionCommand.replace("uncommittedChanges", "branches"),
    projectionCommand.replace("uncommittedChanges", "$field"),
    projectionCommand.replace("but status", "but status --refresh"),
    `cd /workspace/other\n${projectionCommand}`,
    `echo '${projectionCommand}'`,
  ]) {
    assert.doesNotMatch(evidence(command, "[]") ?? "", marker, command)
  }
  assert.doesNotMatch(
    evidence(projectionCommand, "failed", scope, true),
    marker,
  )
  assert.doesNotMatch(
    evidence("printf placeholder", "snapshot=gitbutler-uncommitted []"),
    marker,
  )
})
