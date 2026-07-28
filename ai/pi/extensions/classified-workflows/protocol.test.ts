import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import {
  boundedDiagnosticTail,
  sanitizeProcessDiagnostic,
  summarizePiJsonLines,
  unknownErrorMessage,
  usageTokensFromAssistantMessage,
  usageTokensFromPiJsonLine,
} from "./protocol.ts";

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

test("assistant usage exposes completed child-turn cost for cumulative provider caps", () => {
  assert.equal(
    usageTokensFromAssistantMessage({ role: "assistant", usage: { input: 3, output: 5, cacheRead: 7, totalTokens: 15 } }),
    15,
  );
  assert.equal(usageTokensFromAssistantMessage({ role: "user", usage: { totalTokens: 99 } }), 0);
});

test("streaming usage reads only completed assistant turns", () => {
  assert.equal(
    usageTokensFromPiJsonLine(JSON.stringify({
      type: "message_end",
      message: { role: "assistant", usage: { input: 11, output: 7, totalTokens: 23 } },
    })),
    23,
  );
  assert.equal(
    usageTokensFromPiJsonLine(JSON.stringify({
      type: "message_end",
      message: { role: "toolResult", usage: { totalTokens: 999 } },
    })),
    0,
  );
  assert.equal(usageTokensFromPiJsonLine("not json"), 0);
});

test("stderr diagnostics retain only a bounded tail", () => {
  assert.equal(boundedDiagnosticTail("12345", "67890", 6), "567890");
  assert.equal(boundedDiagnosticTail("", "short", 10), "short");
  assert.throws(() => boundedDiagnosticTail("", "x", 0), /positive/i);
});

test("process diagnostics redact common credential shapes", () => {
  const diagnostic = sanitizeProcessDiagnostic(
    "Authorization: Bearer bearer-secret api_key=api-secret password: pass-secret https://user:pw@example.test/path\nmodel not found",
  );
  assert.doesNotMatch(diagnostic, /bearer-secret|api-secret|pass-secret|user:pw/i);
  assert.match(diagnostic, /\[REDACTED\]/);
  assert.match(diagnostic, /model not found/);
});

test("cross-realm workflow errors retain their actionable message", () => {
  const error = vm.runInNewContext('new ReferenceError("phase is not defined")');
  assert.equal(unknownErrorMessage(error, "Workflow failed closed"), "phase is not defined");
  assert.equal(unknownErrorMessage(null, "Workflow failed closed"), "Workflow failed closed");
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
