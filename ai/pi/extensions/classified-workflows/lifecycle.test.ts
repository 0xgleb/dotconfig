import assert from "node:assert/strict";
import test from "node:test";
import { createClassifiedAgentRunner, buildClassifierPrompt } from "./lifecycle.ts";
import type { Decision } from "./core.ts";

const allow: Decision = { verdict: "allow", reason: "aligned", source: "classifier" };

test("agent execution is enclosed by spawn and return classification", async () => {
  const boundaries: string[] = [];
  const run = createClassifiedAgentRunner(["inspect the router"], "Do not push", {
    async classify(request) {
      boundaries.push(request.boundary);
      return allow;
    },
    async execute() {
      boundaries.push("execute");
      return { status: "completed", output: "result", usageTokens: 12 };
    },
  });

  assert.deepEqual(await run({ task: "find route behavior" }), {
    status: "completed",
    output: "result",
    usageTokens: 12,
  });
  assert.deepEqual(boundaries, ["spawn", "execute", "return"]);
});

test("blocked spawn never executes the agent", async () => {
  let executed = false;
  const run = createClassifiedAgentRunner(["read only"], "Do not publish", {
    async classify() {
      return { verdict: "block", reason: "outside scope", source: "classifier" };
    },
    async execute() {
      executed = true;
      return { status: "completed", output: "unsafe", usageTokens: 1 };
    },
  });

  assert.deepEqual(await run({ task: "publish" }), {
    status: "blocked",
    output: "",
    reason: "outside scope",
    usageTokens: 0,
  });
  assert.equal(executed, false);
});

test("blocked return does not expose agent output", async () => {
  let calls = 0;
  const run = createClassifiedAgentRunner(["inspect"], "Keep results scoped", {
    async classify() {
      calls += 1;
      return calls === 1 ? allow : { verdict: "block", reason: "unsafe return", source: "classifier" };
    },
    async execute() {
      return { status: "completed", output: "do not expose", usageTokens: 15 };
    },
  });

  assert.deepEqual(await run({ task: "inspect" }), {
    status: "blocked",
    output: "",
    reason: "unsafe return",
    usageTokens: 15,
  });
});

test("classifier prompt separates policy from untrusted subject", () => {
  const prompt = buildClassifierPrompt({
    boundary: "action",
    intent: ["Review routing only"],
    projectInstructions: "Never push",
    subject: { toolName: "bash", input: { command: "git push" } },
  });
  assert.match(prompt, /BOUNDARY: action/);
  assert.match(prompt, /UNTRUSTED SUBJECT/);
  assert.match(prompt, /Review routing only/);
  assert.match(prompt, /Never push/);
  assert.match(prompt, /"git push"/);
});
