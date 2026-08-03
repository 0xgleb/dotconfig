import assert from "node:assert/strict";
import test from "node:test";
import {
  assistantPhase,
  observeToolProgress,
  runningToolProgressPhase,
  runningToolsPhase,
  startToolProgress,
  toolPhase,
  usageThrottleLabel,
} from "./core.ts";

test("visible model thinking is explicitly labeled as reasoning with no implied tools", () => {
  assert.deepEqual(
    assistantPhase({ content: [{ type: "thinking", thinking: "Identifying classifier bug" }] }),
    { kind: "reasoning", label: "REASONING · model generation · no tools implied" },
  );
});

test("usage throttle is visible only in dotconfig and Yielduck sessions", () => {
  assert.match(
    usageThrottleLabel("/Users/example/.config", "/Users/example") ?? "",
    /THROTTLED · 5m.*human prompts bypass/,
  );
  assert.match(
    usageThrottleLabel(
      "/Users/example/code/dataclique/yielduck",
      "/Users/example",
    ) ?? "",
    /THROTTLED · 5m/,
  );
  assert.equal(
    usageThrottleLabel("/Users/example/code/st0x", "/Users/example"),
    undefined,
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

test("long-running tool progress shows elapsed time and bounded output counts", () => {
  const started = startToolProgress("bash", 1_000);
  const observed = observeToolProgress(
    started,
    { content: [{ type: "text", text: "first\nsecond\nthird" }] },
  );
  assert.deepEqual(observed, {
    toolName: "bash",
    startedAt: 1_000,
    updateCount: 1,
    bufferedLineCount: 3,
  });
  assert.equal(
    runningToolProgressPhase([observed], 13_400).label,
    "TOOL · bash · process running · 12s · 1 update · 3 buffered lines",
  );
});

test("progress heartbeat never renders buffered output or tool arguments", () => {
  const secret = "TOKEN=do-not-render";
  const observed = observeToolProgress(
    startToolProgress("bash", 1_000),
    { content: [{ type: "text", text: secret }], details: { command: secret } },
  );
  const label = runningToolProgressPhase([observed], 4_000).label;
  assert.doesNotMatch(label, /TOKEN|do-not-render|command/);
  assert.match(label, /3s · 1 update · 1 buffered line/);
});

test("silent and parallel tools receive a compact elapsed heartbeat", () => {
  const read = startToolProgress("read", 4_000);
  const bash = observeToolProgress(startToolProgress("bash", 1_000), undefined);
  assert.equal(
    runningToolProgressPhase([read, bash], 11_000).label,
    "TOOLS · 2 running · filesystem + process running · oldest 10s · 1 update · heartbeat",
  );
});
