import assert from "node:assert/strict"
import test from "node:test"

import { requiredGitButlerModeExitDisprovesBlock } from "./gitbutler-mode-exit.ts"

const diagnosticBranch = (
  diagnostic: string,
  command = "but status -f --format agent",
) => [
  {
    type: "message",
    message: {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "call-1",
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
      toolCallId: "call-1",
      isError: true,
      content: [{ type: "text", text: diagnostic }],
    },
  },
]

const required =
  "Error: GitButler mode exit required: please run but teardown to preserve your work."

test("exact current GitButler mode-exit diagnostics override a necessity-only deadlock", () => {
  assert.equal(
    requiredGitButlerModeExitDisprovesBlock({
      reason:
        "Teardown is not necessary; use the initialized GitButler workflow instead.",
      command: "but teardown --format agent",
      branch: diagnosticBranch(required, "but branch list --format agent"),
    }),
    true,
  )
})

test("mode-exit correction stays fail-closed without exact command, diagnostic, or safe reason", () => {
  const branch = diagnosticBranch(required)
  assert.equal(
    requiredGitButlerModeExitDisprovesBlock({
      reason: "Use the initialized GitButler workflow instead.",
      command: "but teardown",
      branch,
    }),
    false,
  )
  assert.equal(
    requiredGitButlerModeExitDisprovesBlock({
      reason: "Use the initialized GitButler workflow instead.",
      command: "but teardown --format agent",
      branch: diagnosticBranch("GitButler is ready."),
    }),
    false,
  )
  assert.equal(
    requiredGitButlerModeExitDisprovesBlock({
      reason: "This destructive operation is unauthorized.",
      command: "but teardown --format agent",
      branch,
    }),
    false,
  )
})

test("a newer contradictory GitButler diagnostic keeps teardown blocked", () => {
  const branch = [
    ...diagnosticBranch(required),
    {
      type: "message",
      message: {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "call-2",
            name: "bash",
            arguments: { command: "but status -f --format agent" },
          },
        ],
      },
    },
    {
      type: "message",
      message: {
        role: "toolResult",
        toolCallId: "call-2",
        isError: false,
        content: [
          { type: "text", text: "GitButler workspace is initialized." },
        ],
      },
    },
  ]
  assert.equal(
    requiredGitButlerModeExitDisprovesBlock({
      reason: "Teardown is not necessary.",
      command: "but teardown --format agent",
      branch,
    }),
    false,
  )
})
