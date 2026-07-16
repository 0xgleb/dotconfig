import assert from "node:assert/strict";
import test from "node:test";
import { summarizePiJsonLines } from "./protocol.ts";

test("JSON event summaries use the last assistant text and aggregate usage", () => {
  const summary = summarizePiJsonLines([
    "not json",
    JSON.stringify({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "first" }],
        usage: { input: 10, output: 4, totalTokens: 20 },
        stopReason: "toolUse",
      },
    }),
    JSON.stringify({
      type: "message_end",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "hidden" },
          { type: "text", text: "final" },
        ],
        usage: { input: 7, output: 3 },
        stopReason: "stop",
      },
    }),
  ]);

  assert.deepEqual(summary, {
    output: "final",
    usageTokens: 30,
    stopReason: "stop",
    errorMessage: undefined,
  });
});

test("error metadata is retained without exposing non-assistant events", () => {
  const summary = summarizePiJsonLines([
    JSON.stringify({ type: "tool_result_end", message: { role: "toolResult", content: [{ type: "text", text: "secret" }] } }),
    JSON.stringify({
      type: "message_end",
      message: {
        role: "assistant",
        content: [],
        usage: {},
        stopReason: "error",
        errorMessage: "provider failed",
      },
    }),
  ]);

  assert.deepEqual(summary, {
    output: "",
    usageTokens: 0,
    stopReason: "error",
    errorMessage: "provider failed",
  });
});
