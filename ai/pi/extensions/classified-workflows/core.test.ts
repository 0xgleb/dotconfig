import assert from "node:assert/strict";
import test from "node:test";
import {
  deterministicDecision,
  deterministicToolResultDecision,
  MIN_AGENT_TOKEN_RESERVATION,
  parseClassifierDecision,
  runWorkflowScript,
  type AgentRequest,
  type AgentResult,
  type WorkflowLimits,
} from "./core.ts";

const limits: WorkflowLimits = {
  maxAgents: 4,
  concurrency: 2,
  agentTimeoutMs: 1_000,
  workflowTimeoutMs: 5_000,
  retries: 0,
  tokenBudget: 10_000,
};

test("credential-shaped paths are always blocked", () => {
  const cases: Array<{ toolName: string; input: Record<string, unknown> }> = [
    { toolName: "read", input: { path: ".env" } },
    { toolName: "grep", input: { path: "config/secrets.yaml" } },
    { toolName: "read", input: { file_path: "certs/signing.pem" } },
    { toolName: "bash", input: { command: "rg token .env.production" } },
    { toolName: "bash", input: { command: "rg token -g '.env'" } },
  ];
  for (const { toolName, input } of cases) {
    const decision = deterministicDecision({
      boundary: "action",
      toolName,
      input,
      cwd: "/repo",
    });
    assert.equal(decision?.verdict, "block");
  }
});

test("read-only tools are allowed after the credential guard", () => {
  const example = deterministicDecision({
    boundary: "action",
    toolName: "read",
    input: { path: ".env.example" },
    cwd: "/repo",
  });
  const decision = deterministicDecision({
    boundary: "action",
    toolName: "grep",
    input: { pattern: "classify", path: "src" },
    cwd: "/repo",
  });
  assert.deepEqual(decision, {
    verdict: "allow",
    reason: "Read-only operation outside protected paths",
    source: "deterministic",
  });
  assert.equal(example?.verdict, "allow");
});

test("writes inside the working directory are allowed", () => {
  const decision = deterministicDecision({
    boundary: "action",
    toolName: "edit",
    input: { path: "/repo/src/index.ts" },
    cwd: "/repo",
  });
  assert.equal(decision?.verdict, "allow");
});

test("todo tracking is allowed as session-local agent work support", () => {
  for (const input of [
    { action: "list" },
    { action: "add", text: "Move the Graphite stack" },
    { action: "toggle", id: 1 },
    { action: "block", id: 1, reason: "External dependency" },
    { action: "unblock", id: 1 },
    { action: "clear" },
  ]) {
    const decision = deterministicDecision({
      boundary: "action",
      toolName: "todo",
      input,
      cwd: "/repo",
    });
    assert.deepEqual(decision, {
      verdict: "allow",
      reason: "Session-local agent work tracking",
      source: "deterministic",
    });
  }
});

test("the dedicated Pi reload tool is locally allowed", () => {
  assert.deepEqual(
    deterministicDecision({ boundary: "action", toolName: "reload_pi", input: {}, cwd: "/repo" }),
    { verdict: "allow", reason: "Local Pi resource reload", source: "deterministic" },
  );
  assert.deepEqual(deterministicToolResultDecision("reload_pi"), {
    verdict: "allow",
    reason: "Locally generated mutation acknowledgement",
    source: "deterministic",
  });
});

test("dotconfig staging, commit, and push delivery is deterministic but shell chaining is not", () => {
  for (const command of ["git add -- AGENTS.md", "git commit -m 'fix(pi): continue work'", "git push"]) {
    assert.deepEqual(
      deterministicDecision({ boundary: "action", toolName: "bash", input: { command }, cwd: "/Users/example/.config" }),
      { verdict: "allow", reason: "Dotconfig commit and push delivery", source: "deterministic" },
    );
  }
  assert.equal(
    deterministicDecision({
      boundary: "action",
      toolName: "bash",
      input: { command: "git push; echo unsafe" },
      cwd: "/Users/example/.config",
    }),
    null,
  );
});

test("the confirmed obsolete dotconfig model artifact can be removed exactly", () => {
  assert.deepEqual(
    deterministicDecision({
      boundary: "action",
      toolName: "bash",
      input: { command: "rm -- ai/pi.models.json" },
      cwd: "/Users/example/.config",
    }),
    { verdict: "allow", reason: "Confirmed obsolete dotconfig model artifact cleanup", source: "deterministic" },
  );
  assert.equal(
    deterministicDecision({
      boundary: "action",
      toolName: "bash",
      input: { command: "rm -- ai/other.json" },
      cwd: "/Users/example/.config",
    }),
    null,
  );
});

test("shell and unknown tools require classifier review", () => {
  assert.equal(
    deterministicDecision({
      boundary: "action",
      toolName: "bash",
      input: { command: "git status" },
      cwd: "/repo",
    }),
    null,
  );
});

test("locally generated mutation acknowledgements bypass result classification", () => {
  for (const toolName of ["edit", "write", "todo"]) {
    assert.deepEqual(deterministicToolResultDecision(toolName), {
      verdict: "allow",
      reason: "Locally generated mutation acknowledgement",
      source: "deterministic",
    });
  }
  assert.equal(deterministicToolResultDecision("read"), null);
  assert.equal(deterministicToolResultDecision("bash"), null);
  assert.equal(deterministicToolResultDecision("browser"), null);
});

test("broad searches require explicit credential exclusions", () => {
  const native = deterministicDecision({
    boundary: "action",
    toolName: "grep",
    input: { pattern: "route", path: "/repo" },
    cwd: "/repo",
  });
  assert.equal(native?.verdict, "block");

  const shell = deterministicDecision({
    boundary: "action",
    toolName: "bash",
    input: { command: "rg --files" },
    cwd: "/repo",
  });
  assert.equal(shell?.verdict, "block");

  const excluded = deterministicDecision({
    boundary: "action",
    toolName: "bash",
    input: {
      command:
        "rg --files -g '!.env*' -g '!credentials.json' -g '!secrets.json' -g '!secrets.yaml' -g '!*.key' -g '!*.pem' -g '!*.p12' -g '!*.pfx'",
    },
    cwd: "/repo",
  });
  assert.equal(excluded, null);

  const spoofed = deterministicDecision({
    boundary: "action",
    toolName: "bash",
    input: {
      command:
        "rg --files # -g '!.env*' -g '!credentials.json' -g '!secrets.json' -g '!secrets.yaml' -g '!*.key' -g '!*.pem' -g '!*.p12' -g '!*.pfx'",
    },
    cwd: "/repo",
  });
  assert.equal(spoofed?.verdict, "block");
});

test("classifier decisions are strict JSON and fail closed", () => {
  assert.deepEqual(parseClassifierDecision('{"verdict":"allow","reason":"aligned"}'), {
    verdict: "allow",
    reason: "aligned",
    source: "classifier",
  });
  assert.equal(parseClassifierDecision("allow").verdict, "block");
  assert.equal(parseClassifierDecision('{"verdict":"maybe"}').verdict, "block");
});

test("workflow JavaScript can fan out and synthesize", async () => {
  const calls: AgentRequest[] = [];
  const result = await runWorkflowScript(
    `const outputs = await parallel([
      () => agent({ task: "alpha" }),
      () => agent({ task: "beta" })
    ]);
    return outputs.map((item) => item.output).join("+");`,
    limits,
    {
      async runAgent(request): Promise<AgentResult> {
        calls.push(request);
        return { status: "completed", output: request.task.toUpperCase(), usageTokens: 10 };
      },
      async checkpoint() {
        return "approved";
      },
    },
  );
  assert.equal(result, "ALPHA+BETA");
  assert.deepEqual(
    calls.map(({ task }) => task).sort(),
    ["alpha", "beta"],
  );
});

test("workflow supports positional agent calls and direct promise fan-out", async () => {
  const calls: AgentRequest[] = [];
  const result = await runWorkflowScript(
    `const outputs = await parallel([
      agent("alpha", { tools: ["read"] }),
      agent("beta")
    ]);
    return outputs.map((item) => item.output).join("+");`,
    limits,
    {
      async runAgent(request): Promise<AgentResult> {
        calls.push(request);
        return { status: "completed", output: request.task.toUpperCase(), usageTokens: 10 };
      },
      async checkpoint() {
        return "approved";
      },
    },
  );
  assert.equal(result, "ALPHA+BETA");
  assert.deepEqual(calls, [
    { task: "alpha", tools: ["read"] },
    { task: "beta" },
  ]);
});

test("undersized token budgets fail before spawning an idle worker", async () => {
  let spawned = 0;
  await assert.rejects(
    runWorkflowScript(`return await agent({ task: "never start" });`, { ...limits, tokenBudget: 3_999 }, {
      async runAgent(): Promise<AgentResult> {
        spawned += 1;
        return { status: "completed", output: "unexpected", usageTokens: 1 };
      },
      async checkpoint(): Promise<"approved"> {
        return "approved";
      },
    }),
    new RegExp(`minimum reservation.*${MIN_AGENT_TOKEN_RESERVATION}`, "i"),
  );
  assert.equal(spawned, 0);
});

test("workflow enforces total agent and token limits", async () => {
  const dependencies = {
    async runAgent(): Promise<AgentResult> {
      return { status: "completed", output: "ok", usageTokens: 75 };
    },
    async checkpoint(): Promise<"approved"> {
      return "approved";
    },
  };

  await assert.rejects(
    runWorkflowScript(
      `await agent({ task: "one" }); await agent({ task: "two" });`,
      { ...limits, maxAgents: 1 },
      dependencies,
    ),
    /agent limit/i,
  );

  await assert.rejects(
    runWorkflowScript(
      `await agent({ task: "one" }); await agent({ task: "two" });`,
      { ...limits, tokenBudget: 50 },
      dependencies,
    ),
    /token budget/i,
  );

  await assert.rejects(
    runWorkflowScript(`await agent({ task: ${JSON.stringify("x".repeat(32_001))} });`, limits, dependencies),
    /32,000 characters/i,
  );
});

test("headless checkpoints deny instead of auto-approving", async () => {
  await assert.rejects(
    runWorkflowScript(`await checkpoint("publish"); return "done";`, limits, {
      async runAgent(): Promise<AgentResult> {
        return { status: "completed", output: "unused", usageTokens: 0 };
      },
      async checkpoint() {
        return "denied";
      },
    }),
    /checkpoint denied/i,
  );
});

test("workflow and per-agent cancellation fail promptly", async () => {
  const aborted = new AbortController();
  aborted.abort(new Error("Workflow aborted"));
  await assert.rejects(
    runWorkflowScript("return 'never';", limits, {
      async runAgent(): Promise<AgentResult> {
        return { status: "completed", output: "unused", usageTokens: 0 };
      },
      async checkpoint() {
        return "approved";
      },
    }, aborted.signal),
    /workflow aborted/i,
  );

  await assert.rejects(
    runWorkflowScript("return await agent({ task: 'hang' });", { ...limits, agentTimeoutMs: 10 }, {
      async runAgent(): Promise<AgentResult> {
        return new Promise(() => undefined);
      },
      async checkpoint() {
        return "approved";
      },
    }),
    /agent timed out/i,
  );
});
