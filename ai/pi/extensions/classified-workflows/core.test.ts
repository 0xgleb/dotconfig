import assert from "node:assert/strict";
import test from "node:test";
import {
  deterministicDecision,
  deterministicToolResultDecision,
  MIN_AGENT_TOKEN_RESERVATION,
  MIN_CLASSIFIED_AGENT_TIMEOUT_MS,
  minimumRetryEnvelopeMs,
  parseClassifierDecision,
  runWorkflowScript,
  shouldCarryDeterministicResultAllowance,
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

test("negative find predicates are exclusions rather than credential access", () => {
  const command = `for dir in data var runtime state; do if [ -d "$dir" ]; then find "$dir" -maxdepth 3 -type f \\( -name '*.db' -o -name '*.sqlite' -o -name '*.sqlite3' \\) -print; fi; done
find . -maxdepth 2 -type f \\( -name '*.db' -o -name '*.sqlite' -o -name '*.sqlite3' \\) ! -name '.env*' ! -name '*credential*' ! -name '*secret*' ! -name '*.key' ! -name '*.pem' ! -name '*.crt' -print`;
  assert.equal(
    deterministicDecision({ boundary: "action", toolName: "bash", input: { command }, cwd: "/repo" }),
    null,
  );
  assert.equal(
    deterministicDecision({
      boundary: "action",
      toolName: "bash",
      input: { command: "find . -maxdepth 2 -type f -name '.env*' -print" },
      cwd: "/repo",
    })?.verdict,
    "block",
  );
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

test("non-blocking user questions are locally allowed", () => {
  for (const input of [
    { action: "list" },
    { action: "ask", question: "Choose?", guess: "A" },
    { action: "resolve", id: 1, answer: "A" },
    { action: "clear_resolved" },
  ]) {
    assert.deepEqual(
      deterministicDecision({ boundary: "action", toolName: "ask_user", input, cwd: "/repo" }),
      {
        verdict: "allow",
        reason: "Session-local non-blocking user question tracking",
        source: "deterministic",
      },
    );
  }
  assert.equal(deterministicToolResultDecision("ask_user")?.verdict, "allow");
});

test("typed local agent registry coordination is locally allowed without granting project tools", () => {
  for (const action of [
    "list",
    "claim",
    "release",
    "requests",
    "claim_request",
    "cancel_request",
  ]) {
    assert.deepEqual(
      deterministicDecision({ boundary: "action", toolName: "agent_registry", input: { action }, cwd: "/repo" }),
      {
        verdict: "allow",
        reason: "Local typed agent responsibility coordination",
        source: "deterministic",
      },
    );
  }
  for (const action of ["delegate", "complete_request", "fail_request"]) {
    assert.equal(
      deterministicDecision({ boundary: "action", toolName: "agent_registry", input: { action }, cwd: "/repo" }),
      null,
    );
  }
  assert.equal(deterministicToolResultDecision("agent_registry"), null);
  assert.equal(
    deterministicDecision({ boundary: "action", toolName: "bash", input: { command: "ssh prod" }, cwd: "/repo" }),
    null,
  );
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
      {
        verdict: "allow",
        reason: "Dotconfig commit and push delivery",
        source: "deterministic",
        resultSafe: true,
      },
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

test("project-local Rust incremental cache cleanup is narrowly deterministic", () => {
  assert.deepEqual(
    deterministicDecision({
      boundary: "action",
      toolName: "bash",
      input: {
        command:
          "cd /Users/0xgleb/code/dataclique/yielduck && rm -rf target/debug/incremental && df -h . | tail -1",
      },
      cwd: "/Users/0xgleb/code/dataclique/yielduck",
    }),
    {
      verdict: "allow",
      reason: "Project-local rebuildable Rust incremental cache cleanup",
      source: "deterministic",
      resultSafe: true,
    },
  );
  for (const command of [
    "rm -rf target",
    "rm -rf target/release",
    "rm -rf ../target/debug/incremental",
    "rm -rf target/debug/incremental; rm -rf src",
    "cd /tmp/project && rm -rf target/debug/incremental",
  ]) {
    assert.equal(
      deterministicDecision({ boundary: "action", toolName: "bash", input: { command }, cwd: "/repo" }),
      null,
    );
  }
});

test("git diff credential pathspecs are allowed only when every sensitive token is an exclusion", () => {
  const commands = [
    "git diff base...head -- . ':(glob,exclude)**/.env*' ':(glob,exclude)**/*secret*' ':(glob,exclude)**/*.pem'",
    "git -C /Users/example/code/st0x/st0x.rest.api diff base-sha head-sha -- . ':(exclude,glob)**/.env*' ':(exclude).env*' ':(exclude,icase,glob)**/*secret*' ':(exclude,icase,glob)**/*.key' ':(exclude,icase,glob)**/*.pem' ':(exclude,icase,glob)**/*.p12' ':(exclude,icase,glob)**/*.pfx'",
  ];
  for (const command of commands) {
    assert.deepEqual(
      deterministicDecision({ boundary: "action", toolName: "bash", input: { command }, cwd: "/repo" }),
      {
        verdict: "allow",
        reason: "Read-only Git diff with credential-shaped paths used exclusively as exclusions",
        source: "deterministic",
      },
    );
  }

  for (const unsafe of [
    "git diff -- .env",
    "git diff --output=/tmp/diff.txt -- . ':(glob,exclude)**/.env*'",
    "git diff -- . ':(glob,exclude)**/.env*'; cat README.md",
  ]) {
    assert.notEqual(
      deterministicDecision({ boundary: "action", toolName: "bash", input: { command: unsafe }, cwd: "/repo" })?.verdict,
      "allow",
    );
  }
});

test("exact read-only review-panel sentinels are deterministic without broad cursor-agent authority", () => {
  for (const command of [
    'cursor-agent -p --mode plan --model composer-2.5 --trust "Reply with exactly: OK"',
    "cursor-agent -p --mode plan --model grok-4.5-xhigh --trust 'Reply with exactly: OK'",
  ]) {
    assert.deepEqual(
      deterministicDecision({ boundary: "action", toolName: "bash", input: { command }, cwd: "/repo" }),
      {
        verdict: "allow",
        reason: "Exact read-only review-panel availability sentinel",
        source: "deterministic",
      },
    );
  }
  for (const command of [
    'cursor-agent -p --mode plan --model composer-2.5 --trust "Review the repo"',
    'cursor-agent -p --mode agent --model composer-2.5 --trust "Reply with exactly: OK"',
    'cursor-agent -p --mode plan --model composer-2.5 --trust "Reply with exactly: OK"; git push',
  ]) {
    assert.equal(
      deterministicDecision({ boundary: "action", toolName: "bash", input: { command }, cwd: "/repo" }),
      null,
    );
  }
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
  for (const toolName of ["edit", "write", "todo", "ask_user"]) {
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

test("only deterministic actions with intrinsically safe output carry result allowance", () => {
  const git = deterministicDecision({
    boundary: "action",
    toolName: "bash",
    input: { command: "git push" },
    cwd: "/Users/example/.config",
  });
  const read = deterministicDecision({
    boundary: "action",
    toolName: "read",
    input: { path: "README.md" },
    cwd: "/repo",
  });
  assert.equal(git ? shouldCarryDeterministicResultAllowance(git) : false, true);
  assert.equal(read ? shouldCarryDeterministicResultAllowance(read) : false, false);
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

test("classified workflow tools reserve enough wall time for both classifier boundaries and child execution", () => {
  assert.equal(MIN_CLASSIFIED_AGENT_TIMEOUT_MS, 180_000);
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

test("workflow timeout preflight leaves room for the configured retry envelope", async () => {
  assert.equal(minimumRetryEnvelopeMs(180_000, 2), 541_500);
  await assert.rejects(
    runWorkflowScript("return 'never';", { ...limits, agentTimeoutMs: 180_000, workflowTimeoutMs: 240_000, retries: 2 }, {
      async runAgent(): Promise<AgentResult> {
        return { status: "completed", output: "unused", usageTokens: 0 };
      },
      async checkpoint(): Promise<"approved"> {
        return "approved";
      },
    }),
    /cannot fit.*retry envelope/i,
  );
});

test("thrown agent timeouts consume retries instead of killing the workflow immediately", async () => {
  let attempts = 0;
  const result = await runWorkflowScript(
    `return await agent({ task: "retry me" });`,
    { ...limits, retries: 2 },
    {
      async runAgent(): Promise<AgentResult> {
        attempts += 1;
        if (attempts < 3) throw new Error("Agent timed out");
        return { status: "completed", output: "recovered", usageTokens: 10 };
      },
      async checkpoint(): Promise<"approved"> {
        return "approved";
      },
    },
  );
  assert.equal(attempts, 3);
  assert.deepEqual(result, { status: "completed", output: "recovered", usageTokens: 10 });
});

test("exhausted thrown timeouts become typed results and preserve parallel siblings", async () => {
  const result = await runWorkflowScript(
    `return await parallel([agent("slow"), agent("fast")]);`,
    { ...limits, retries: 1 },
    {
      async runAgent(request): Promise<AgentResult> {
        if (request.task === "slow") throw new Error("Agent timed out");
        return { status: "completed", output: "useful", usageTokens: 10 };
      },
      async checkpoint(): Promise<"approved"> {
        return "approved";
      },
    },
  );
  assert.deepEqual(result, [
    { status: "timed-out", output: "", reason: "Agent timed out", usageTokens: 0 },
    { status: "completed", output: "useful", usageTokens: 10 },
  ]);
});

test("in-flight fan-out preserves completed results when measured usage crosses the aggregate budget", async () => {
  const result = await runWorkflowScript(
    `return await parallel([agent("one"), agent("two")]);`,
    { ...limits, maxAgents: 2, concurrency: 2, tokenBudget: 10_000 },
    {
      async runAgent(request): Promise<AgentResult> {
        return { status: "completed", output: request.task, usageTokens: 6_000 };
      },
      async checkpoint(): Promise<"approved"> {
        return "approved";
      },
    },
  );
  assert.deepEqual(result, [
    { status: "completed", output: "one", usageTokens: 6_000 },
    { status: "completed", output: "two", usageTokens: 6_000 },
  ]);
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

test("workflow cancellation rejects while per-agent timeout returns a typed failure", async () => {
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

  assert.deepEqual(
    await runWorkflowScript("return await agent({ task: 'hang' });", { ...limits, agentTimeoutMs: 10 }, {
      async runAgent(): Promise<AgentResult> {
        return new Promise(() => undefined);
      },
      async checkpoint() {
        return "approved";
      },
    }),
    { status: "timed-out", output: "", reason: "Agent timed out", usageTokens: 0 },
  );
});
