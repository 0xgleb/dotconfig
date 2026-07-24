import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_REMOTE_MESSAGE_CHARACTERS,
  RemoteBridgeError,
  boundedBridgeText,
  finalAssistantText,
  remoteTurnPrompt,
} from "./protocol.ts";

test("remote prompts are explicitly communication-only", () => {
  const prompt = remoteTurnPrompt("Give me a concise status update.");
  assert.match(prompt, /all tools are disabled/i);
  assert.match(prompt, /Do not execute or approve actions/i);
  assert.match(prompt, /Give me a concise status update/);
});

test("bridge text rejects control characters and oversized messages", () => {
  assert.throws(() => boundedBridgeText("message", "bad\u0000text", 100), RemoteBridgeError);
  assert.throws(
    () => boundedBridgeText("message", "x".repeat(MAX_REMOTE_MESSAGE_CHARACTERS + 1), MAX_REMOTE_MESSAGE_CHARACTERS),
    RemoteBridgeError,
  );
});

test("only bounded final assistant text becomes the bridge response", () => {
  assert.equal(
    finalAssistantText([
      { role: "assistant", content: [{ type: "thinking", thinking: "private" }] },
      {
        role: "assistant",
        content: [
          { type: "text", text: "first" },
          { type: "toolCall", name: "bash" },
          { type: "text", text: "second" },
        ],
      },
    ]),
    "first\nsecond",
  );
  assert.equal(finalAssistantText([{ role: "user", content: "hello" }]), undefined);
});
