import assert from "node:assert/strict"
import { join } from "node:path"
import test from "node:test"
import {
  branchExecutionEvidence,
  selectRelevantExecutionEvidence,
} from "../pi/extensions/classified-workflows/execution-evidence.ts"

const scope = process.cwd()
const subject = {
  toolName: "bash",
  cwd: scope,
  input: {
    command:
      'git commit --only -m "keep pi host modules out of runtime dependencies" -- ai/pi/extensions/package.json ai/pi/extensions/package-lock.json ai/test/pi-host-package-boundary.test.ts',
  },
}
const readReceipt = (id: string, path: string, text: string) => [
  {
    type: "message",
    message: {
      role: "assistant",
      content: [{ type: "toolCall", id, name: "read", arguments: { path } }],
    },
  },
  {
    type: "message",
    message: {
      role: "toolResult",
      toolName: "read",
      toolCallId: id,
      isError: false,
      content: [{ type: "text", text }],
    },
  },
]
const runnerSources = [
  [
    ".git/hooks/pre-commit",
    'exec "$PREK" hook-impl --hook-type=pre-commit -- "$@"',
  ],
  [
    ".pre-commit-config.yaml",
    "entry: prettier --write --config prettier.config.mjs",
  ],
  ["prettier.config.mjs", "export default { semi: false }"],
] as const

const churn = Array.from({ length: 24 }, (_, index) =>
  readReceipt(
    `other-${index}`,
    join(scope, "ai", "test", `other-${index}.ts`),
    "Other package test notes; not a hook or runner inspection.",
  ),
).flat()

test("selective publication retains inspected runner sources after unrelated read churn", () => {
  const branch = [
    ...runnerSources.flatMap(([path, text], index) =>
      readReceipt(`runner-${index}`, join(scope, path), text),
    ),
    ...churn,
  ]
  const evidence = branchExecutionEvidence({ branch, subject, scope })
  for (const [path] of runnerSources) {
    assert.ok(evidence.some(receipt => receipt.includes(join(scope, path))))
  }
  const selected = selectRelevantExecutionEvidence(evidence, subject)
  for (const [path] of runnerSources) {
    assert.ok(
      selected.some(receipt => receipt.includes(join(scope, path))),
      `lost inspected runner source: ${path}`,
    )
  }
})

test("only the latest read of each runner source is retained", () => {
  const path = join(scope, ".git/hooks/pre-commit")
  const branch = [
    ...readReceipt("old-hook", path, "old hook body"),
    ...churn,
    ...readReceipt("current-hook", path, "current hook body"),
  ]
  const selected = selectRelevantExecutionEvidence(
    branchExecutionEvidence({ branch, subject, scope }),
    subject,
  )
  assert.equal(selected.filter(receipt => receipt.includes(path)).length, 1)
  assert.ok(selected.some(receipt => receipt.includes("current hook body")))
})

test("runner reads from another workspace do not gain the extra retention lane", () => {
  const otherScope = join(scope, "ai")
  const evidence = branchExecutionEvidence({
    branch: [
      ...readReceipt(
        "foreign",
        join(otherScope, ".git/hooks/pre-commit"),
        "foreign hook",
      ),
      ...churn,
    ],
    subject,
    scope: otherScope,
  })
  assert.equal(
    selectRelevantExecutionEvidence(evidence, subject, 1, 0).some(receipt =>
      receipt.includes("foreign hook"),
    ),
    false,
  )
})

test("ordinary non-Git actions do not gain runner-source retention", () => {
  const evidence = branchExecutionEvidence({
    branch: [
      ...readReceipt("hook", join(scope, ".git/hooks/pre-commit"), "hook body"),
      ...churn,
    ],
    subject,
    scope,
  })
  const nonGitSubject = {
    ...subject,
    input: { command: "prettier --check README.md" },
  }
  assert.equal(
    selectRelevantExecutionEvidence(evidence, nonGitSubject, 1, 0).some(
      receipt => receipt.includes("hook body"),
    ),
    false,
  )
})
