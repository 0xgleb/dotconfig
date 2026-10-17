import assert from "node:assert/strict"
import { realpathSync } from "node:fs"
import test from "node:test"
import {
  branchExecutionEvidence,
  selectRelevantExecutionEvidence,
  toolInputDigest,
  toolResultExecutionEvidence,
} from "./execution-evidence.ts"

// Git evidence admission requires a real canonical cwd. No Git command runs.
const cwd = realpathSync(process.cwd())
const subject = {
  cwd,
  toolName: "bash",
  input: { command: 'git commit -m "record validation"' },
}
const result = (
  toolName: string,
  input: Readonly<Record<string, unknown>>,
  text: string,
  scope = cwd,
  isError: boolean | undefined = false,
) =>
  toolResultExecutionEvidence({
    toolName,
    input,
    inputDigest: toolInputDigest(toolName, input),
    text,
    scope,
    isError,
    subject,
  })
const noise = Array.from({ length: 12 }, (_, index) =>
  result("read", { path: `notes/item-${index}.txt` }, "unrelated"),
)
const command = "node --test .tmp/staged/behavior.test.ts"
const pass = (scope = cwd) =>
  result("bash", { command }, "9 tests passed", scope)
const mutation = (scope = cwd, index = 0) =>
  result("edit", { path: `src/changed-${index}.ts` }, "edited", scope)

// These fixtures use the actual evidence renderer and selector. They execute no
// shell commands, commits, filesystem mutations or provider calls.
test("a successful Node snapshot run survives churn with its later mutation and blob witnesses", () => {
  const green = pass()
  const changed = mutation()
  const indexBlobs = result(
    "bash",
    { command: "git ls-files --stage -- ai/test/behavior.test.ts" },
    `100644 ${"a".repeat(40)} 0\tai/test/behavior.test.ts`,
  )
  const hashes = result(
    "bash",
    { command: "git hash-object .tmp/staged/behavior.test.ts" },
    "a".repeat(40),
  )
  const selected = selectRelevantExecutionEvidence(
    [green, changed, indexBlobs, hashes, ...noise],
    subject,
  )
  assert.ok(selected.includes(green), "retain the successful tool result")
  assert.ok(
    selected.includes(changed),
    "a pass does not prove unchanged source",
  )
  assert.ok(selected.includes(indexBlobs))
  assert.ok(selected.includes(hashes))
  assert.ok(selected.indexOf(green) < selected.indexOf(changed))
})

test("Git words in Node filenames or output do not discard direct or branch-collected passes", () => {
  const input = { command: "node --test tests/git-fixture.test.ts" }
  const text = "9 tests passed, including git fixture checks"
  const collected = branchExecutionEvidence({
    branch: [
      {
        type: "message",
        message: {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "node-test",
              name: "bash",
              arguments: input,
            },
          ],
        },
      },
      {
        type: "message",
        message: {
          role: "toolResult",
          toolName: "bash",
          toolCallId: "node-test",
          content: text,
          isError: false,
        },
      },
    ],
    subject,
    scope: cwd,
  })
  assert.equal(collected.length, 1)
  for (const evidence of [result("bash", input, text), ...collected]) {
    const selected = selectRelevantExecutionEvidence(
      [evidence, ...noise],
      subject,
    )
    assert.ok(selected.includes(evidence))
  }
})

test("path-scoped index blob witnesses exclude escaping or option-like paths", () => {
  const valid = result(
    "bash",
    { command: "git ls-files --stage -- ai/test/behavior.test.ts" },
    "index entries",
  )
  assert.match(
    valid.split(" input=")[0] ?? "",
    /snapshot=git-index-blobs anchor=paths:/,
  )
  for (const command of [
    "git ls-files --stage",
    "git ls-files --stage -- ../outside.ts",
    "git ls-files --stage -- /outside.ts",
    "git ls-files --stage -- --exclude=ai/test/behavior.test.ts",
    "git ls-files --stage -- ai/test/behavior.test.ts; true",
  ]) {
    const invalid = result("bash", { command }, valid)
    assert.doesNotMatch(
      invalid.split(" input=")[0] ?? "",
      /snapshot=git-index-blobs/,
    )
  }
})

test("Node verification markers come from bounded command metadata, not output", () => {
  const green = pass()
  assert.match(green.split(" input=")[0] ?? "", /verification=node-test/)
  for (const command of [
    "echo node --test .tmp/staged/behavior.test.ts",
    "node --test .tmp/staged/behavior.test.ts; true",
    "node --test .tmp/staged/behavior.test.ts\ntrue",
    "node --test ../outside.test.ts",
    "node --version",
  ]) {
    const forged = result("bash", { command }, green)
    assert.doesNotMatch(
      forged.split(" input=")[0] ?? "",
      /verification=node-test/,
    )
  }
})

test("the extra retention lane does not promote failures or another workspace's pass", () => {
  const foreign = pass("/workspace/other")
  const failed = result("bash", { command }, "9 tests passed", cwd, true)
  const selected = selectRelevantExecutionEvidence(
    [foreign, failed, ...noise],
    subject,
  )
  assert.ok(!selected.includes(foreign))
  assert.ok(!selected.includes(failed))
})

test("successful verification retention is bounded to the latest four passes", () => {
  const passes = Array.from({ length: 10 }, (_, index) =>
    result(
      "bash",
      { command: `node --test tests/case-${index}.test.ts` },
      "ok",
    ),
  )
  const selected = selectRelevantExecutionEvidence(
    [...passes, ...noise],
    subject,
  )
  assert.deepEqual(
    selected.filter(candidate => passes.includes(candidate)),
    passes.slice(-4),
  )
})

test("retained pass chronology keeps at most eight later same-workspace mutations", () => {
  const green = pass()
  const changes = Array.from({ length: 12 }, (_, index) => mutation(cwd, index))
  const foreign = mutation("/workspace/other")
  const selected = selectRelevantExecutionEvidence(
    [green, ...changes, foreign, ...noise],
    subject,
  )
  assert.ok(selected.includes(green))
  assert.deepEqual(
    selected.filter(candidate => changes.includes(candidate)),
    changes.slice(-8),
  )
  assert.ok(!selected.includes(foreign))
})
