import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { AgentResult, WorkflowLimits } from "./core.ts";
import {
  MAX_RETAINED_CHILD_OUTPUT_CHARACTERS,
  WORKFLOW_AUDIT_ENTRY,
  appendWorkflowAudit,
  auditedAgentRunner,
  emptyWorkflowAuditState,
  latestFailedWorkflowAfter,
  nextWorkflowSequence,
  restoreWorkflowAudits,
  terminalWorkflowFailureDisprovesOwnershipBlock,
  workflowAuditEvidence,
  type ChildAudit,
} from "./workflow-audit.ts";

const extensionSource = readFileSync(new URL("./index.ts", import.meta.url), "utf8");

const limits: WorkflowLimits = {
  maxAgents: 2,
  concurrency: 2,
  agentTimeoutMs: 300_000,
  workflowTimeoutMs: 600_000,
  retries: 0,
  tokenBudget: 10_000,
};

test("workflow allocation and audit reads reconcile late persisted snapshots", () => {
  assert.match(
    extensionSource,
    /const startBackgroundWorkflow[\s\S]*?refreshWorkflowAudits\(ctx\)[\s\S]*?nextWorkflowId\+\+/,
  );
  assert.match(
    extensionSource,
    /name: "workflow_audit"[\s\S]*?refreshWorkflowAudits\(ctx\)/,
  );
  assert.match(
    extensionSource,
    /refreshWorkflowAudits\(ctx\)\s*const auditId = `wf-\$\{nextWorkflowId\+\+\}`/,
  );
});

test("audited runner records bounded zero-token timeout diagnostics", async () => {
  const children: ChildAudit[] = [];
  const run = auditedAgentRunner(
    async (): Promise<AgentResult> => ({
      status: "timed-out",
      output: "",
      reason: "child timeout\nraw stack should collapse",
      usageTokens: 0,
    }),
    children,
    (text) => text.replace(/\s+/g, " "),
  );
  await run(
    { task: "review", model: "openai-codex/gpt-5.6-luna", tools: ["read"] },
    new AbortController().signal,
  );
  assert.deepEqual(children, [
    {
      index: 1,
      requestedModel: "openai-codex/gpt-5.6-luna",
      tools: ["read"],
      startedAt: children[0]?.startedAt,
      finishedAt: children[0]?.finishedAt,
      status: "timed-out",
      usageTokens: 0,
      outputCharacters: 0,
      reason: "child timeout raw stack should collapse",
    },
  ]);
});

test("completed review children retain bounded access diagnostics", async () => {
  const children: ChildAudit[] = [];
  const run = auditedAgentRunner(
    async (): Promise<AgentResult> => ({
      status: "completed",
      output: JSON.stringify({
        findings: [],
        reviewer_error: "repository source became unavailable",
      }),
      usageTokens: 42,
      diagnostic:
        "Child action blocked: source path was not established by current evidence",
    }),
    children,
    (text) => text.replace(/\s+/g, " "),
  );

  await run(
    { task: "review", model: "openai-codex/gpt-5.6-luna", tools: ["read"] },
    new AbortController().signal,
    1_000,
  );

  assert.match(children[0]?.reason ?? "", /Child action blocked/);
  assert.match(children[0]?.reason ?? "", /repository source became unavailable/);
  assert.match(
    children[0]?.retainedOutput ?? "",
    /repository source became unavailable/,
  );
});

test("completed child outputs are retained only within the audit bound", async () => {
  const children: ChildAudit[] = [];
  const run = auditedAgentRunner(
    async (): Promise<AgentResult> => ({
      status: "completed",
      output: "x".repeat(MAX_RETAINED_CHILD_OUTPUT_CHARACTERS + 500),
      usageTokens: 42,
    }),
    children,
    String,
  );

  await run({ task: "review", tools: ["read"] }, new AbortController().signal, 1_000);
  assert.equal(
    children[0]?.retainedOutput?.length,
    MAX_RETAINED_CHILD_OUTPUT_CHARACTERS,
  );
  assert.equal(
    children[0]?.outputCharacters,
    MAX_RETAINED_CHILD_OUTPUT_CHARACTERS + 500,
  );
});

test("audited runner emits bounded child start and terminal progress", async () => {
  const children: ChildAudit[] = [];
  const events: unknown[] = [];
  const run = auditedAgentRunner(
    async (): Promise<AgentResult> => ({
      status: "completed",
      output: "done",
      usageTokens: 42,
    }),
    children,
    String,
    (event) => events.push(event),
  );

  await run(
    { task: "review", model: "openai-codex/gpt-5.6-luna", tools: ["read"] },
    new AbortController().signal,
    1_000,
  );

  assert.deepEqual(events[0], {
    kind: "started",
    index: 1,
    requestedModel: "openai-codex/gpt-5.6-luna",
    tools: ["read"],
  });
  assert.deepEqual(events[1], { kind: "finished", audit: children[0] });
});

test("workflow audit sequences continue after reload without replacing prior runs", () => {
  const state = appendWorkflowAudit(
    appendWorkflowAudit(emptyWorkflowAuditState, {
      id: "wf-2",
      label: "older",
      status: "completed",
      startedAt: 1,
      finishedAt: 2,
      limits,
      children: [],
    }),
    {
      id: "wf-7",
      label: "newer",
      status: "completed",
      startedAt: 3,
      finishedAt: 4,
      limits,
      children: [],
    },
  );
  assert.equal(nextWorkflowSequence(state), 8);
  assert.equal(nextWorkflowSequence(emptyWorkflowAuditState), 1);
});

test("terminal child failures release duplicate-work ownership for a corrected retry", () => {
  const state = appendWorkflowAudit(emptyWorkflowAuditState, {
    id: "wf-5",
    label: "release planning",
    status: "completed",
    startedAt: 1,
    finishedAt: 2,
    limits,
    children: [
      {
        index: 1,
        requestedModel: "unauthenticated/model-a",
        tools: ["read"],
        startedAt: 1,
        finishedAt: 2,
        status: "failed",
        usageTokens: 0,
        outputCharacters: 0,
        reason: "model unavailable or unauthenticated",
      },
      {
        index: 2,
        requestedModel: "unauthenticated/model-b",
        tools: ["read"],
        startedAt: 1,
        finishedAt: 2,
        status: "failed",
        usageTokens: 0,
        outputCharacters: 0,
        reason: "model unavailable or unauthenticated",
      },
    ],
    outcome: "both agents failed",
  });

  assert.equal(
    terminalWorkflowFailureDisprovesOwnershipBlock(
      "wf-5 already owns this task and no failure is evidenced",
      state,
    ),
    true,
  );
  assert.equal(
    terminalWorkflowFailureDisprovesOwnershipBlock(
      "wf-5 violates publication policy",
      state,
    ),
    false,
  );
  assert.deepEqual(workflowAuditEvidence(state), [
    "typed workflow audit: wf-5 status=completed; children=1:failed:0t:model unavailable or unauthenticated, 2:failed:0t:model unavailable or unauthenticated; outcome=both agents failed",
  ]);
});

test("same-job recovery selects only the latest failed audit and preserves partial metadata", () => {
  const blockedFailure = {
    id: "wf-30",
    label: "PR307 review",
    status: "failed" as const,
    startedAt: 20,
    finishedAt: 30,
    limits,
    children: [
      {
        index: 1,
        tools: ["read"],
        startedAt: 21,
        finishedAt: 22,
        status: "blocked" as const,
        usageTokens: 0,
        outputCharacters: 0,
        reason: "scoped search required",
      },
    ],
    outcome: "token budget preflight failed",
  };
  const state = appendWorkflowAudit(emptyWorkflowAuditState, blockedFailure);
  assert.equal(latestFailedWorkflowAfter(state, 20)?.id, "wf-30");
  assert.equal(latestFailedWorkflowAfter(state, 21), undefined);

  const partialFailure = {
    ...blockedFailure,
    id: "wf-31",
    startedAt: 31,
    finishedAt: 32,
    children: [
      {
        ...blockedFailure.children[0],
        status: "completed" as const,
        outputCharacters: 80,
      },
    ],
  };
  assert.deepEqual(
    latestFailedWorkflowAfter(
      appendWorkflowAudit(state, partialFailure),
      20,
    ),
    partialFailure,
  );
  for (const status of ["completed", "cancelled"] as const) {
    assert.equal(
      latestFailedWorkflowAfter(
        appendWorkflowAudit(emptyWorkflowAuditState, {
          ...blockedFailure,
          status,
        }),
        20,
      ),
      undefined,
    );
  }
});

test("completed child work retains ownership", () => {
  const state = appendWorkflowAudit(emptyWorkflowAuditState, {
    id: "wf-6",
    label: "successful review",
    status: "completed",
    startedAt: 1,
    finishedAt: 2,
    limits,
    children: [
      {
        index: 1,
        tools: ["read"],
        startedAt: 1,
        finishedAt: 2,
        status: "completed",
        usageTokens: 200,
        outputCharacters: 50,
      },
    ],
  });

  assert.equal(
    terminalWorkflowFailureDisprovesOwnershipBlock(
      "wf-6 already owns this task",
      state,
    ),
    false,
  );
});

test("workflow audit restoration merges snapshots appended across a reload", () => {
  const beforeReload = appendWorkflowAudit(emptyWorkflowAuditState, {
    id: "wf-27",
    label: "first review",
    status: "completed",
    startedAt: 10,
    finishedAt: 20,
    limits,
    children: [],
    outcome: "first",
  });
  const oldRuntimeCompletedLate = appendWorkflowAudit(beforeReload, {
    id: "wf-28",
    label: "background review",
    status: "completed",
    startedAt: 21,
    finishedAt: 40,
    limits,
    children: [],
    outcome: "late terminal result",
  });
  const newRuntimeSnapshot = appendWorkflowAudit(beforeReload, {
    id: "wf-29",
    label: "next review",
    status: "completed",
    startedAt: 41,
    finishedAt: 50,
    limits,
    children: [],
    outcome: "new runtime",
  });

  const restored = restoreWorkflowAudits([
    { type: "custom", customType: WORKFLOW_AUDIT_ENTRY, data: beforeReload },
    {
      type: "custom",
      customType: WORKFLOW_AUDIT_ENTRY,
      data: oldRuntimeCompletedLate,
    },
    {
      type: "custom",
      customType: WORKFLOW_AUDIT_ENTRY,
      data: newRuntimeSnapshot,
    },
  ]);

  assert.deepEqual(
    restored.workflows.map(({ id }) => id),
    ["wf-27", "wf-28", "wf-29"],
  );
  assert.equal(nextWorkflowSequence(restored), 30);
});

test("workflow audits survive reload and compaction state restoration", () => {
  const state = appendWorkflowAudit(emptyWorkflowAuditState, {
    id: "wf-2",
    label: "review",
    status: "failed",
    startedAt: 1,
    finishedAt: 2,
    limits,
    children: [],
    outcome: "timed out",
  });
  assert.deepEqual(
    restoreWorkflowAudits([
      { type: "custom", customType: WORKFLOW_AUDIT_ENTRY, data: state },
    ]),
    state,
  );
  assert.deepEqual(
    restoreWorkflowAudits([
      {
        type: "custom",
        customType: WORKFLOW_AUDIT_ENTRY,
        data: { workflows: [null] },
      },
    ]),
    emptyWorkflowAuditState,
  );
});
