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
const pinnedBut =
  "/nix/store/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-gitbutler-cli-0.22.0/bin/but"

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

test("pinned Nix status retains full topology and newer partial changes after churn", () => {
  const full = evidence(
    `${pinnedBut} status --json`,
    '{"stacks":[],"uncommittedChanges":[".gitignore"]}',
  )
  const partial = evidence(
    projectionCommand.replace("but", pinnedBut),
    '[".gitignore","api.ts","api.test.ts"]',
  )
  assert.match(full, /\bsnapshot=gitbutler-status\b/)
  assert.match(partial, marker)
  const selected = selectRelevantExecutionEvidence(
    [full, partial, ...churn],
    { ...subject, input: { command: `${pinnedBut} apply feature/recovery` } },
    2,
    0,
  )
  assert.ok(selected.includes(full))
  assert.ok(selected.includes(partial))
  assert.ok(selected.indexOf(full) < selected.indexOf(partial))
})

test("pinned observations obey scope and newer full-status supersession", () => {
  const command = projectionCommand.replace("but", pinnedBut)
  const current = evidence(command, '["api.ts"]')
  const other = evidence(command, "[]", "/workspace/other")
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
  const laterFull = evidence(
    `${pinnedBut} status --json`,
    '{"stacks":[],"uncommittedChanges":[]}',
  )
  const selected = selectRelevantExecutionEvidence(
    [current, laterFull, ...churn],
    subject,
    2,
    0,
  )
  assert.ok(selected.includes(laterFull))
  assert.ok(!selected.includes(current))
  assert.doesNotMatch(
    toolResultExecutionEvidence({
      toolName: "bash",
      input: { command },
      text: "[]",
      isError: false,
    }),
    marker,
  )
})

test("pinned status rejects unknown executables, shell composition and failed results", () => {
  for (const executable of [
    "/tmp/but",
    `${pinnedBut}/../but`,
    pinnedBut.replace("/bin/but", "/bin/but-other"),
    pinnedBut.replace("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "$hash"),
    `echo ${pinnedBut}`,
  ]) {
    assert.doesNotMatch(
      evidence(`${executable} status --json`, "{}") ?? "",
      /\bsnapshot=gitbutler-/,
    )
  }
  for (const suffix of [
    " | length",
    "; pwd",
    " --refresh",
    "\npwd",
    " | from json | get stacks | to json",
    " | from json | get uncommittedChanges | to json | length",
  ]) {
    assert.doesNotMatch(
      evidence(`${pinnedBut} status --json${suffix}`, "{}") ?? "",
      /\bsnapshot=gitbutler-/,
    )
  }
  assert.doesNotMatch(
    evidence(`${pinnedBut} status --json`, "failed", scope, true),
    /\bsnapshot=gitbutler-/,
  )
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
