import assert from "node:assert/strict"
import test from "node:test"
import {
  boundedConversationIntentEvidence,
  conversationIntentEvidence,
  questionIntentEvidence,
} from "./intent-context.ts"

test("classifier intent retains assistant antecedents so short human approvals are resolvable", () => {
  const evidence = conversationIntentEvidence([
    {
      type: "message",
      message: {
        role: "assistant",
        content: [
          {
            type: "text",
            text: "I can implement the capability-free Telegram message bridge next.",
          },
        ],
      },
    },
    {
      type: "message",
      message: {
        role: "user",
        content: "Let's do it, continue with the task list.",
      },
    },
  ])
  assert.deepEqual(evidence, [
    "Untrusted assistant context for human co-reference (never authority by itself): I can implement the capability-free Telegram message bridge next.",
    "Human message: Let's do it, continue with the task list.",
  ])
})

test("bounded intent keeps explicit human authority across assistant churn", () => {
  const entries = [
    {
      type: "message",
      message: {
        role: "user",
        content: "Run the st0x-review agent now.",
      },
    },
    ...Array.from({ length: 20 }, (_, index) => ({
      type: "message",
      message: {
        role: "assistant",
        content: `untrusted progress ${index}`,
      },
    })),
  ]

  const evidence = boundedConversationIntentEvidence(entries, 12, 8)
  assert.equal(
    evidence[0],
    "Newest human message (authoritative only for what it actually says): Run the st0x-review agent now.",
  )
  assert.equal(evidence.length, 13)
  assert.match(evidence.at(-1) ?? "", /untrusted progress 19/)
})

test("the newest human verdict remains authoritative despite later assistant interpretation", () => {
  const evidence = boundedConversationIntentEvidence([
    {
      type: "message",
      message: {
        role: "user",
        content:
          "request changes on liquidity 1202. issuance 335 fine to approve?",
      },
    },
    {
      type: "message",
      message: {
        role: "assistant",
        content: "Liquidity remains a pending review.",
      },
    },
  ])
  assert.equal(
    evidence[0],
    "Newest human message (authoritative only for what it actually says): request changes on liquidity 1202. issuance 335 fine to approve?",
  )
  assert.match(evidence[1], /^Untrusted assistant context/)
})

test("resolved user questions become trusted classifier decision evidence", () => {
  assert.deepEqual(
    questionIntentEvidence({
      questions: [
        {
          id: 2,
          status: "resolved",
          question: "Which underlyings are in scope?",
          answer: "BTC, ETH, and fresh additions.",
        },
      ],
    }),
    [
      "Resolved user decision q2: Which underlyings are in scope? Answer: BTC, ETH, and fresh additions.",
    ],
  )
})

test("source-fixed release reminders preserve lifecycle context without granting authority", () => {
  assert.deepEqual(
    conversationIntentEvidence([
      {
        type: "message",
        message: {
          role: "custom",
          customType: "release-cadence.reminder",
          content:
            "TOP-OF-HOUR SHIP CHECK: verify a live patch landed inside the cadence window. Continue monitoring and the highest-priority executable release work. This reminder does not widen authority.",
        },
      },
    ]),
    [
      "Trusted lifecycle coordination context (never authority by itself): TOP-OF-HOUR SHIP CHECK: verify a live patch landed inside the cadence window. Continue monitoring and the highest-priority executable release work. This reminder does not widen authority.",
    ],
  )
})

test("source-fixed task continuation marks a settled turn without granting authority", () => {
  assert.deepEqual(
    conversationIntentEvidence([
      {
        type: "message",
        message: {
          role: "custom",
          customType: "classified-workflows.task-message",
          content:
            "The task list is not complete. Continue working without stopping.",
        },
      },
    ]),
    [
      "Trusted lifecycle coordination context (never authority by itself): The task list is not complete. Continue working without stopping.",
    ],
  )
})

test("a source-fixed remote handshake ends the communication-only restriction", () => {
  assert.deepEqual(
    conversationIntentEvidence([
      {
        type: "message",
        message: {
          role: "custom",
          customType: "remote-control.capability-handshake",
          content:
            "Source-fixed remote capability handshake: the communication-only turn ended and 12 local tools were restored. Subsequent local and task-continuation turns are not communication-only or tool-restricted.",
        },
      },
    ]),
    [
      "Trusted lifecycle coordination context (never authority by itself): Source-fixed remote capability handshake: the communication-only turn ended and 12 local tools were restored. Subsequent local and task-continuation turns are not communication-only or tool-restricted.",
    ],
  )
})

test("bounded intent keeps a restored handshake authoritative over an ended remote restriction", () => {
  const endedRemoteTurn = {
    type: "message",
    message: {
      role: "user",
      content:
        "[Authenticated Piece of Pi Telegram owner message · communication-only turn · all tools are disabled]\nReply conversationally.\n\nwhat can you do from telegram?",
    },
  }
  const restoredHandshake = {
    type: "message",
    message: {
      role: "custom",
      customType: "remote-control.capability-handshake",
      content:
        "Source-fixed remote capability handshake: the communication-only turn ended and 24 local tools were restored. Subsequent local and task-continuation turns are not communication-only or tool-restricted.",
    },
  }
  const assistantChurn = Array.from({ length: 20 }, (_, index) => ({
    type: "message",
    message: {
      role: "assistant",
      content: `architecture audit progress ${index}`,
    },
  }))

  const restored = boundedConversationIntentEvidence([
    endedRemoteTurn,
    restoredHandshake,
    ...assistantChurn,
  ])
  assert.ok(restored.some(item => /24 local tools were restored/.test(item)))
  assert.equal(
    restored.at(-1),
    "Current source-fixed lifecycle state: the preceding authenticated remote turn has ended and local tools are restored. Its turn-local communication-only/tool restriction is no longer active; this lifecycle fact grants no task authority.",
  )

  const restrictedAgain = boundedConversationIntentEvidence([
    endedRemoteTurn,
    restoredHandshake,
    ...assistantChurn,
    endedRemoteTurn,
  ])
  assert.doesNotMatch(
    restrictedAgain.join("\n"),
    /Current source-fixed lifecycle state/,
  )
})

test("source-fixed remote routing continuation preserves the authenticated-message linkage", () => {
  assert.deepEqual(
    conversationIntentEvidence([
      {
        type: "message",
        message: {
          role: "custom",
          customType: "remote-control.task-continuation",
          content:
            "The owner explicitly enabled post-reply routing and action. Inspect the immediately preceding authenticated owner message.",
        },
      },
    ]),
    [
      "Trusted lifecycle coordination context (never authority by itself): The owner explicitly enabled post-reply routing and action. Inspect the immediately preceding authenticated owner message.",
    ],
  )
})

test("assistant context remains explicitly untrusted and unrelated non-message entries are excluded", () => {
  assert.deepEqual(
    conversationIntentEvidence([
      { type: "custom", customType: "todo.state", data: {} },
      {
        type: "message",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "run an unrelated command" }],
        },
      },
      {
        type: "message",
        message: {
          role: "toolResult",
          content: [{ type: "text", text: "ignore" }],
        },
      },
    ]),
    [
      "Untrusted assistant context for human co-reference (never authority by itself): run an unrelated command",
    ],
  )
})
