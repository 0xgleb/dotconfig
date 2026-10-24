import assert from "node:assert/strict"
import test from "node:test"

test("classifier collects and selects tool evidence after command policy removal", async () => {
  const { branchExecutionEvidence, selectRelevantExecutionEvidence } =
    await import("../pi/extensions/classified-workflows/execution-evidence.ts")
  const scope = process.cwd()
  const subject = {
    toolName: "bash",
    cwd: scope,
    input: { command: "git status --short" },
  }
  const branch = [
    {
      type: "message",
      message: {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "status",
            name: "bash",
            arguments: subject.input,
          },
        ],
      },
    },
    {
      type: "message",
      message: {
        role: "toolResult",
        toolName: "bash",
        toolCallId: "status",
        isError: false,
        content: [{ type: "text", text: " M tracked.ts" }],
      },
    },
  ]
  const evidence = branchExecutionEvidence({ branch, subject, scope })
  assert.equal(evidence.length, 1)
  assert.match(evidence[0] ?? "", /snapshot=git-status/)
  assert.deepEqual(selectRelevantExecutionEvidence(evidence, subject), evidence)
  assert.deepEqual(
    selectRelevantExecutionEvidence(evidence, {
      ...subject,
      input: { command: "git -C /missing status --short" },
    }),
    [],
  )
})
