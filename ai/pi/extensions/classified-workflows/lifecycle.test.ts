import assert from "node:assert/strict";
import test from "node:test";
import {
  buildClassifierPrompt,
  createClassifiedAgentRunner,
  createToolResultAllowance,
  formatDecisionReason,
  resolveActionDecision,
} from "./lifecycle.ts";
import type { Decision } from "./core.ts";
import {
  CONTINUATION_PAUSE_ENTRY,
  isContinuationPaused,
  latestContinuationPause,
  parseContinuationPause,
  wasRunAborted,
} from "../shared/continuation-pause.ts";

const allow: Decision = { verdict: "allow", reason: "aligned", source: "classifier" };

test("manual abort pause state persists defensively and keys off the final assistant", () => {
  const paused = { paused: true, updatedAt: 42 };
  assert.deepEqual(parseContinuationPause(paused), paused);
  assert.equal(parseContinuationPause({ paused: "yes", updatedAt: 42 }), undefined);
  assert.deepEqual(
    latestContinuationPause([
      { type: "custom", customType: CONTINUATION_PAUSE_ENTRY, data: paused },
      { type: "message", message: { role: "user", content: "later" } },
    ]),
    paused,
  );
  assert.equal(
    wasRunAborted([
      { role: "assistant", stopReason: "aborted" },
      { role: "assistant", stopReason: "stop" },
    ]),
    false,
  );
  assert.equal(wasRunAborted([{ role: "assistant", stopReason: "aborted" }]), true);
  assert.equal(isContinuationPaused([{ type: "custom", customType: CONTINUATION_PAUSE_ENTRY, data: paused }]), true);
  assert.equal(
    isContinuationPaused([
      { type: "custom", customType: CONTINUATION_PAUSE_ENTRY, data: paused },
      { type: "custom", customType: CONTINUATION_PAUSE_ENTRY, data: { paused: false, updatedAt: 43 } },
    ]),
    false,
  );
});

test("deterministically allowed actions carry one matching result allowance", () => {
  const allowance = createToolResultAllowance();
  allowance.record("call-1");
  assert.equal(allowance.consume("call-1"), true);
  assert.equal(allowance.consume("call-1"), false);
  allowance.record("call-2");
  allowance.clear();
  assert.equal(allowance.consume("call-2"), false);
});

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
  assert.match(prompt, /agent-registry discovery and scoped delegation/i);
  assert.match(prompt, /todo\/task-tracking mutations/i);
  assert.match(prompt, /do not block merely because the user did not literally ask to create a todo/i);
  assert.match(prompt, /all still-active user requests/i);
  assert.match(prompt, /not just the most recent subtask/i);
});

test("classifier prompt treats parent-authored spawn tasks as scoped instructions, not returned prompt injection", () => {
  const prompt = buildClassifierPrompt({
    boundary: "spawn",
    intent: ["Reproduce the handed-over background child-process failure"],
    projectInstructions: "Use read-only child agents first",
    subject: { task: "Reply with exactly CHILD_OK and do not call tools", tools: ["read"] },
  });

  assert.match(prompt, /spawn.*parent-authored child task/is);
  assert.match(prompt, /not prompt injection solely because/i);
  assert.match(prompt, /requested output format/i);
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

test("classifier prompt allows relevant unauthenticated protocol API introspection", () => {
  const prompt = buildClassifierPrompt({
    boundary: "action",
    intent: ["Active todo: implement the Morpho integration"],
    projectInstructions: "Verify external API contracts against real responses",
    subject: {
      toolName: "bash",
      input: { command: "python3 -c 'query the public Morpho GraphQL schema'" },
    },
  });

  assert.match(prompt, /public protocol APIs/i);
  assert.match(prompt, /GraphQL schema introspection/i);
  assert.match(prompt, /active goal, todo list, project source/i);
  assert.match(prompt, /recent chat discussed a different support task/i);
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

test("classifier prompt allows explicitly mandated business operations despite mutation", () => {
  const prompt = buildClassifierPrompt({
    boundary: "action",
    intent: ["Run the required release build, deploy it, and verify the production warning disappears"],
    projectInstructions: "Run tests before release",
    subject: { toolName: "bash", input: { command: "release-build && deploy" } },
  });
  assert.match(prompt, /explicitly mandated business operation/i);
  assert.match(prompt, /must allow/i);
  assert.match(prompt, /state-changing.*not.*reason to block/is);
  assert.match(prompt, /unless.*hard prohibition|hard prohibition.*unless/is);
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
