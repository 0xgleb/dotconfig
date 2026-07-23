import assert from "node:assert/strict";
import test from "node:test";
import { AGENT_PROCESS_STDIO, buildAgentArguments, resolveAgentModel } from "./agent-process.ts";

test("workflow children load only the classified workflow extension explicitly", () => {
  assert.deepEqual(
    buildAgentArguments(
      { task: "inspect", tools: ["read", "bash"], model: "reviewer", thinking: "high" },
      "/repo/classified-workflows/index.ts",
    ),
    [
      "--mode",
      "json",
      "--print",
      "--no-session",
      "--no-extensions",
      "--extension",
      "/repo/classified-workflows/index.ts",
      "--no-skills",
      "--no-prompt-templates",
      "--tools",
      "read,bash",
      "--model",
      "reviewer",
      "--thinking",
      "high",
      "inspect",
    ],
  );
});

test("structured workflow children receive an explicit JSON-only contract", () => {
  const args = buildAgentArguments(
    { task: "inspect", schema: { type: "object", required: ["findings"] } },
    "/repo/index.ts",
  );
  assert.match(args.at(-1) ?? "", /Return only valid JSON matching this JSON Schema/);
  assert.match(args.at(-1) ?? "", /\"required\":\[\"findings\"\]/);
});

test("workflow model preflight resolves only authenticated available providers", () => {
  const available = [
    { provider: "openai-codex", id: "gpt-5.6-sol", name: "GPT-5.6 Sol" },
    { provider: "anthropic", id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6" },
    { provider: "anthropic", id: "claude-sonnet-4-5-20250929", name: "Claude Sonnet 4.5" },
  ];
  assert.equal(resolveAgentModel("gpt-5.6-sol", "openai-codex", available), "openai-codex/gpt-5.6-sol");
  assert.throws(
    () => resolveAgentModel("fable", "openai-codex", available),
    /external claude -p subscription lane/i,
  );
  assert.throws(
    () => resolveAgentModel("sonnet", "openai-codex", available),
    /external claude -p subscription lane/i,
  );
  assert.throws(
    () => resolveAgentModel("anthropic/claude-sonnet-4-6", "openai-codex", available),
    /external claude -p subscription lane/i,
  );
  assert.equal(resolveAgentModel(undefined, "openai-codex", available), undefined);
  assert.throws(
    () => resolveAgentModel(undefined, "anthropic", available),
    /cannot inherit Anthropic API models/i,
  );
  assert.throws(
    () => resolveAgentModel("amazon-bedrock/sonnet", "openai-codex", available),
    /external claude -p subscription lane/i,
  );
  assert.throws(() => resolveAgentModel("nonexistent", "openai-codex", available), /inherit the parent/i);
});

test("JSON workflow children stay hidden behind captured pipes", () => {
  assert.deepEqual(AGENT_PROCESS_STDIO, ["ignore", "pipe", "pipe"]);
  assert.equal(buildAgentArguments({ task: "inspect" }, "/repo/index.ts").includes("json"), true);
});

test("workflow children reject unsupported tools", () => {
  assert.throws(
    () => buildAgentArguments({ task: "inspect", tools: ["read", "unknown"] }, "/repo/index.ts"),
    /unsupported tool/i,
  );
});
