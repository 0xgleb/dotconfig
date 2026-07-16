import assert from "node:assert/strict";
import test from "node:test";
import { Effect, Layer } from "effect";
import {
  buildClassifierPrompt,
  ClassifierConfirmation,
  createClassifiedAgentRunner,
  formatDecisionReason,
  resolveActionDecision,
} from "./lifecycle.ts";
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
    reason: "Auto-classifier verdict: outside scope",
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
    reason: "Auto-classifier verdict: unsafe return",
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

test("classifier prompt treats explicit install and configuration requests as scope", () => {
  const prompt = buildClassifierPrompt({
    boundary: "action",
    intent: ["Install and configure the selected Pi todo extension"],
    projectInstructions: "Never access credential files",
    subject: {
      toolName: "write",
      input: { path: "/Users/example/.pi/agent/extensions/todo.ts" },
      cwd: "/Users/example/code/project",
    },
  });

  assert.match(prompt, /Scope is defined by visible user intent/i);
  assert.match(prompt, /install or configure user-scoped tooling/i);
  assert.match(prompt, /Do not block solely because.*outside.*working directory/i);
});

test("decision reasons identify the policy source", () => {
  assert.equal(
    formatDecisionReason({ verdict: "block", reason: "protected path", source: "deterministic" }),
    "Deterministic policy verdict: protected path",
  );
  assert.equal(
    formatDecisionReason({ verdict: "block", reason: "outside scope", source: "classifier" }),
    "Auto-classifier verdict: outside scope",
  );
});

test("deterministic blocks cannot be overridden", async () => {
  let confirmationRequested = false;
  const result = await Effect.runPromise(
    resolveActionDecision({ verdict: "block", reason: "protected path", source: "deterministic" }).pipe(
      Effect.provide(
        Layer.succeed(ClassifierConfirmation, {
          confirm: () => {
            confirmationRequested = true;
            return Effect.succeed(true);
          },
        }),
      ),
    ),
  );

  assert.equal(confirmationRequested, false);
  assert.deepEqual(result, {
    block: true,
    reason: "Deterministic policy verdict: protected path",
  });
});

test("an interactive user can allow a model-classified block once", async () => {
  const reasons: string[] = [];
  const result = await Effect.runPromise(
    resolveActionDecision({ verdict: "block", reason: "outside scope", source: "classifier" }).pipe(
      Effect.provide(
        Layer.succeed(ClassifierConfirmation, {
          confirm: (reason) => {
            reasons.push(reason);
            return Effect.succeed(true);
          },
        }),
      ),
    ),
  );

  assert.deepEqual(reasons, ["Auto-classifier verdict: outside scope"]);
  assert.equal(result, undefined);
});

test("headless or rejected classifier blocks remain blocked", async () => {
  const decision: Decision = { verdict: "block", reason: "outside scope", source: "classifier" };
  const denied = Layer.succeed(ClassifierConfirmation, { confirm: () => Effect.succeed(false) });

  assert.deepEqual(await Effect.runPromise(resolveActionDecision(decision).pipe(Effect.provide(denied))), {
    block: true,
    reason: "Auto-classifier verdict: outside scope",
  });
});
