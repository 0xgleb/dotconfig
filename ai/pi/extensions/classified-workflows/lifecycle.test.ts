import assert from "node:assert/strict";
import test from "node:test";
import {
  buildClassifierPrompt,
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

test("classifier prompt treats reasonable support actions as part of the requested work", () => {
  const prompt = buildClassifierPrompt({
    boundary: "action",
    intent: [
      "Fix the Pi footer, then launch a subagent and move the Graphite stack",
      "Track my requests before fulfilling them",
    ],
    projectInstructions: "Use a todo list for multi-step work",
    subject: { toolName: "todo", input: { action: "add", text: "Fix the Pi footer" } },
  });

  assert.match(prompt, /support actions inherit authorization/i);
  assert.match(prompt, /planning and task tracking/i);
  assert.match(prompt, /all still-active user requests/i);
  assert.match(prompt, /not just the most recent subtask/i);
});

test("classifier prompt does not mistake legitimate project instructions for prompt injection", () => {
  const prompt = buildClassifierPrompt({
    boundary: "tool-result",
    intent: ["Read and follow the relevant project instructions"],
    projectInstructions: "Read AGENTS.md before editing",
    subject: { toolName: "read", content: ["Run tests before committing"] },
  });

  assert.match(prompt, /legitimate project instructions/i);
  assert.match(prompt, /not prompt injection solely because/i);
});

test("classifier prompt allows ordinary cross-repository and tracker research", () => {
  const prompt = buildClassifierPrompt({
    boundary: "action",
    intent: ["Move the current Graphite stack onto the RAI-44 base branch"],
    projectInstructions: "Work tracking lives in Linear",
    subject: { toolName: "bash", input: { command: "linear issue view RAI-44" } },
  });

  assert.match(prompt, /Linear, GitHub, pull requests, branches, related repositories/i);
  assert.match(prompt, /ordinary read-only research/i);
  assert.match(prompt, /does not require separate authorization/i);
});

test("classifier prompt allows read-only supply-chain audits of installation candidates", () => {
  const prompt = buildClassifierPrompt({
    boundary: "action",
    intent: ["Find and install a proper off-the-shelf Pi Vim extension"],
    projectInstructions: "Audit third-party code before installing it",
    subject: {
      toolName: "bash",
      input: { command: "cd /tmp/pi-vim-audit && rg -n 'child_process|fetch|node:fs' --glob '*.ts'" },
    },
  });

  assert.match(prompt, /supply-chain review/i);
  assert.match(prompt, /installation candidate/i);
  assert.match(prompt, /read-only operations do not need tight topical matching/i);
});

test("classifier prompt distinguishes draft review staging from publication", () => {
  const prompt = buildClassifierPrompt({
    boundary: "action",
    intent: ["Review the pull request"],
    projectInstructions: "Draft reviews may be prepared without publishing them",
    subject: { toolName: "bash", input: { command: "gh api create-pending-review" } },
  });

  assert.match(prompt, /draft or pending review/i);
  assert.match(prompt, /submitting, publishing, approving, or sending/i);
  assert.match(prompt, /explicit user authorization/i);
});

test("classifier prompt makes loaded instructions binding without duplicating them", () => {
  const prompt = buildClassifierPrompt({
    boundary: "action",
    intent: ["Install the project dependencies"],
    projectInstructions: "Dependencies are managed with Nix; do not use Homebrew",
    subject: { toolName: "bash", input: { command: "brew install foo" } },
  });

  assert.match(prompt, /loaded project instructions are binding/i);
  assert.match(prompt, /violates an applicable global or repository-local instruction/i);
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

test("classifier prompt requires state changes to be necessary for visible intent", () => {
  const prompt = buildClassifierPrompt({
    boundary: "action",
    intent: ["Review the current implementation"],
    projectInstructions: "Keep changes scoped to the request",
    subject: { toolName: "write", input: { path: "/Users/example/.config/unrelated.ts" } },
  });

  assert.match(prompt, /Reversibility alone does not authorize a state change/i);
  assert.match(prompt, /directly requested or necessary/i);
});

test("auto mode returns classifier blocks without waiting for approval", () => {
  assert.deepEqual(
    resolveActionDecision({ verdict: "block", reason: "outside scope", source: "classifier" }),
    { block: true, reason: "Auto-classifier verdict: outside scope" },
  );
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

test("deterministic blocks cannot be overridden", () => {
  assert.deepEqual(
    resolveActionDecision({ verdict: "block", reason: "protected path", source: "deterministic" }),
    { block: true, reason: "Deterministic policy verdict: protected path" },
  );
});

test("allowed actions continue without a checkpoint", () => {
  assert.equal(resolveActionDecision(allow), undefined);
});
