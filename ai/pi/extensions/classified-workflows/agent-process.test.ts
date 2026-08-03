import assert from "node:assert/strict";
import test from "node:test";
import {
  AGENT_PROCESS_STDIO,
  buildAgentArguments,
  LOCAL_LANE_PROVIDER,
  localLaneWorkflowRefusal,
  resolveAgentModel,
  WORKFLOW_CHILD_SYSTEM_PROMPT,
} from "./agent-process.ts";

test("workflow orchestration is refused on the local Ollama lane", () => {
  const refusal = localLaneWorkflowRefusal(LOCAL_LANE_PROVIDER);
  assert.ok(refusal, "local lane must receive a refusal message");
  assert.match(refusal ?? "", /route/i);
  assert.match(refusal ?? "", /agent_registry/);
});

test("workflow orchestration stays available to full-capability providers", () => {
  assert.equal(localLaneWorkflowRefusal("openai-codex"), undefined);
  assert.equal(localLaneWorkflowRefusal("anthropic"), undefined);
  assert.equal(localLaneWorkflowRefusal(undefined), undefined);
});

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
      "--no-themes",
      "--no-context-files",
      "--system-prompt",
      WORKFLOW_CHILD_SYSTEM_PROMPT,
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

test("workflow children receive a bounded isolated prompt contract", () => {
  const args = buildAgentArguments({ task: "inspect" }, "/repo/index.ts");
  assert.ok(args.includes("--no-context-files"));
  assert.ok(args.includes("--system-prompt"));
  assert.match(WORKFLOW_CHILD_SYSTEM_PROMPT, /batch independent reads/i);
  assert.match(WORKFLOW_CHILD_SYSTEM_PROMPT, /return.*before exhausting/i);
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
    { provider: "openai-codex", id: "gpt-5.6-luna", name: "GPT-5.6 Luna" },
    { provider: "anthropic", id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6" },
    { provider: "anthropic", id: "claude-sonnet-4-5-20250929", name: "Claude Sonnet 4.5" },
  ];
  assert.equal(resolveAgentModel("gpt-5.6-sol", "openai-codex", available), "openai-codex/gpt-5.6-sol");
  assert.equal(resolveAgentModel("openai/gpt-5.6-sol", "openai-codex", available), "openai-codex/gpt-5.6-sol");
  assert.throws(
    () => resolveAgentModel("openai/gpt-5.6-missing", "openai-codex", available),
    /unavailable or has no configured authentication/i,
  );
  assert.throws(
    () => resolveAgentModel("other/gpt-5.6-sol", "openai-codex", available),
    /unavailable or has no configured authentication/i,
  );
  assert.equal(
    resolveAgentModel("fable", "openai-codex", available),
    "openai-codex/gpt-5.6-luna",
  );
  assert.equal(
    resolveAgentModel("sonnet", "openai-codex", available),
    "openai-codex/gpt-5.6-luna",
  );
  assert.equal(
    resolveAgentModel("opus", "openai-codex", available),
    "openai-codex/gpt-5.6-luna",
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
  assert.throws(
    () =>
      resolveAgentModel("fable", "openai-codex", [
        { provider: "openai-codex", id: "gpt-5.6-sol" },
      ]),
    /requires authenticated openai-codex\/gpt-5\.6-luna/i,
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
