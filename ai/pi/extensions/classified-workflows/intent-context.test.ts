import assert from "node:assert/strict";
import test from "node:test";
import {
  conversationIntentEvidence,
  questionIntentEvidence,
} from "./intent-context.ts";

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
  ]);
  assert.deepEqual(evidence, [
    "Untrusted assistant context for human co-reference (never authority by itself): I can implement the capability-free Telegram message bridge next.",
    "Human message: Let's do it, continue with the task list.",
  ]);
});

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
  );
});

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
  );
});

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
  );
});

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
  );
});
