import assert from "node:assert/strict";
import test from "node:test";
import { AGENT_PROCESS_STDIO, buildAgentArguments, qualifyAgentModel } from "./agent-process.ts";

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

test("unqualified child models inherit the authenticated parent provider when available", () => {
  assert.equal(qualifyAgentModel("gpt-5.6-sol", "openai-codex", true), "openai-codex/gpt-5.6-sol");
  assert.equal(qualifyAgentModel("sonnet", "openai-codex", false), "sonnet");
  assert.equal(qualifyAgentModel("anthropic/claude-sonnet-4-6", "openai-codex", true), "anthropic/claude-sonnet-4-6");
  assert.equal(qualifyAgentModel(undefined, "openai-codex", true), undefined);
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
