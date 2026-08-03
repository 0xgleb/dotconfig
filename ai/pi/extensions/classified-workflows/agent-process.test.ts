import assert from "node:assert/strict";
import test from "node:test";
import { buildAgentArguments } from "./agent-process.ts";

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

test("workflow children reject unsupported tools", () => {
  assert.throws(
    () => buildAgentArguments({ task: "inspect", tools: ["read", "unknown"] }, "/repo/index.ts"),
    /unsupported tool/i,
  );
});
