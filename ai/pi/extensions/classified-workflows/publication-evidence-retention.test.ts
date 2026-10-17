import assert from "node:assert/strict"
import { realpathSync } from "node:fs"
import test from "node:test"
import {
  branchExecutionEvidence,
  selectRelevantExecutionEvidence,
} from "./execution-evidence.ts"

const cwd = realpathSync(new URL(".", import.meta.url))
const subject = {
  cwd,
  toolName: "bash",
  input: { command: "git push origin master" },
}
const command = [
  "^git remote get-url --push --all origin",
  "^git log --format='%H %s' origin/master..HEAD",
  "^git diff-tree --no-commit-id --name-only -r abc1234",
  "^git ls-tree -r HEAD -- docs/a.md docs/b.md",
  "^git hash-object -- docs/a.md docs/b.md",
  "^git diff --check origin/master..HEAD",
].join("\n")
const facts =
  "git@example.test:owner/repo.git\nabc1234 checked docs\ndocs/a.md\ndocs/b.md\n100644 blob abcdef docs/a.md\n100644 blob fedcba docs/b.md\nabcdef\nfedcba"
const receipt = (observedCommand = command) =>
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
              id: "verify",
              name: "bash",
              arguments: { command: observedCommand },
            },
          ],
        },
      },
      {
        type: "message",
        message: {
          role: "toolResult",
          toolName: "bash",
          toolCallId: "verify",
          isError: false,
          content: facts,
        },
      },
    ],
  })

test("recent native multiline publication facts retain success, input digest and verified scope", () => {
  for (const observedCommand of [
    command,
    command.replaceAll("^git", "git"),
    `cd "${cwd}"\n${command}`,
  ]) {
    const evidence = receipt(observedCommand)
    assert.equal(evidence.length, 1)
    const selected = selectRelevantExecutionEvidence(evidence, subject)
    assert.deepEqual(selected, evidence)
    assert.match(
      selected[0] ?? "",
      /result status=success inputDigest=[a-f0-9]{64} scope=[a-f0-9]{16}/,
    )
    assert.match(selected[0] ?? "", /commandScope=verified/)
    for (const fact of facts.split("\n"))
      assert.ok(selected[0]?.includes(fact), fact)
  }
})

test("multi-command receipts with location changes or overrides remain unattributed", () => {
  for (const observedCommand of [
    "git status --short\ncd /outside\ngit status --short",
    "git status --short\ngit -C /outside status --short",
    "git status --short\ngit --git-dir=/outside status --short",
    "git status --short\nGIT_DIR=/outside git status --short",
    "git status --short\n(git status --short)",
  ])
    assert.deepEqual(receipt(observedCommand), [], observedCommand)
})

test("publication facts survive unrelated read churn without becoming authority", () => {
  const evidence = receipt()
  const reads = Array.from(
    { length: 30 },
    (_, i) =>
      `read result status=success input={"path":"docs/other-${i}.md"}: unrelated text`,
  )
  const selected = selectRelevantExecutionEvidence(
    [...evidence, ...reads],
    subject,
  )
  assert.ok(selected.includes(evidence[0] ?? ""))
  assert.doesNotMatch(evidence[0] ?? "", /authority=|approved=/)
})
