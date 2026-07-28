import assert from "node:assert/strict";
import test from "node:test";
import { capProviderOutputTokens, workflowChildTokenLimit } from "./token-cap.ts";

test("workflow child token limits are activated only by a valid bounded internal environment value", () => {
  assert.equal(workflowChildTokenLimit(undefined), undefined);
  assert.equal(workflowChildTokenLimit("20000"), 20_000);
  assert.throws(() => workflowChildTokenLimit("not-a-number"), /environment limit is malformed/);
});

test("workflow child caps OpenAI Responses output before the provider request", () => {
  const payload = {
    model: "gpt-5.6-sol",
    instructions: "bounded review",
    input: [{ role: "user", content: "inspect two files" }],
    max_output_tokens: 128_000,
  };
  const capped = capProviderOutputTokens(payload, 20_000);
  assert.ok(capped.outputTokenLimit > 0);
  assert.ok(capped.outputTokenLimit < 20_000);
  assert.equal(capped.payload.max_output_tokens, capped.outputTokenLimit);
  assert.equal(payload.max_output_tokens, 128_000);
});

test("workflow child caps chat-completion payloads without adding unknown provider fields", () => {
  const payload = {
    model: "compatible-model",
    messages: [{ role: "user", content: "review" }],
    max_completion_tokens: 64_000,
  };
  const capped = capProviderOutputTokens(payload, 10_000);
  assert.equal(capped.payload.max_completion_tokens, capped.outputTokenLimit);
  assert.equal("max_output_tokens" in capped.payload, false);
  assert.equal("max_tokens" in capped.payload, false);
});

test("workflow child fails before dispatch when the request payload already consumes the budget", () => {
  assert.throws(
    () => capProviderOutputTokens({ input: "x".repeat(20_000), max_output_tokens: 100_000 }, 4_000),
    /prompt estimate already consumes token limit/,
  );
});

test("workflow payload estimates match Pi's authoritative four-characters-per-token semantics", () => {
  const payload = {
    model: "gpt-5.6-sol",
    input: "x".repeat(376_000),
    instructions: "bounded review",
    stream: true,
  };
  const capped = capProviderOutputTokens(payload, 108_156, { allowProcessMeasuredOutput: true });
  assert.ok(capped.estimatedPromptTokens >= 94_000);
  assert.ok(capped.estimatedPromptTokens < 95_000);
  assert.ok(capped.outputTokenLimit > 13_000);
});

test("Codex can opt into process-measured enforcement when its endpoint rejects output caps", () => {
  const payload = {
    model: "gpt-5.6-sol",
    input: [],
    instructions: "bounded review",
    stream: true,
  };
  const capped = capProviderOutputTokens(payload, 10_000, { allowProcessMeasuredOutput: true });
  assert.equal(capped.enforcement, "process-measured");
  assert.equal(capped.payload, payload);
  assert.ok(capped.outputTokenLimit > 0);
});

test("workflow child fails closed when the provider payload has no recognized output-token field", () => {
  assert.throws(() => capProviderOutputTokens({ model: "unknown", input: [] }, 10_000), /output-token field/);
});
