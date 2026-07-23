import assert from "node:assert/strict";
import test from "node:test";
import { assistantPhase, runningToolsPhase, toolPhase } from "./core.ts";

test("visible model thinking is explicitly labeled as reasoning with no implied tools", () => {
  assert.deepEqual(
    assistantPhase({ content: [{ type: "thinking", thinking: "Identifying classifier bug" }] }),
    { kind: "reasoning", label: "REASONING · model generation · no tools implied" },
  );
});

test("assistant text and tool argument generation have distinct phases", () => {
  assert.deepEqual(assistantPhase({ content: [{ type: "text", text: "Here is the result" }] }), {
    kind: "response",
    label: "RESPONSE · model generation",
  });
  assert.deepEqual(assistantPhase({ content: [{ type: "toolCall", name: "edit", arguments: {} }] }), {
    kind: "tool",
    label: "TOOL · preparing edit arguments",
  });
});

test("tool phases identify evidenced operation class without inventing wait state", () => {
  assert.equal(toolPhase("read").label, "TOOL · read · filesystem");
  assert.equal(toolPhase("bash").label, "TOOL · bash · process running");
  assert.equal(toolPhase("browser").label, "TOOL · browser · operator browser I/O");
  assert.equal(toolPhase("workflow").label, "SUBAGENT · workflow · model generation");
  assert.equal(toolPhase("unknown_remote").label, "TOOL · unknown_remote · external operation");
});

test("parallel tools report count and observed operation classes", () => {
  assert.deepEqual(runningToolsPhase(["read", "bash"]), {
    kind: "tool",
    label: "TOOLS · 2 running · filesystem + process running",
  });
});
