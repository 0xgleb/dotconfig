import assert from "node:assert/strict";
import test from "node:test";
import type { AgentResult, WorkflowLimits } from "./core.ts";
import {
  WORKFLOW_AUDIT_ENTRY,
  appendWorkflowAudit,
  auditedAgentRunner,
  emptyWorkflowAuditState,
  nextWorkflowSequence,
  restoreWorkflowAudits,
  terminalWorkflowFailureDisprovesOwnershipBlock,
  workflowAuditEvidence,
  type ChildAudit,
} from "./workflow-audit.ts";

const limits: WorkflowLimits = {
  maxAgents: 2,
  concurrency: 2,
  agentTimeoutMs: 300_000,
  workflowTimeoutMs: 600_000,
  retries: 0,
  tokenBudget: 10_000,
};

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
  await run({ task: "review", model: "openai-codex/gpt-5.6-luna", tools: ["read"] }, new AbortController().signal);
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
    terminalWorkflowFailureDisprovesOwnershipBlock("wf-5 violates publication policy", state),
    false,
  );
  assert.deepEqual(workflowAuditEvidence(state), [
    "typed workflow audit: wf-5 status=completed; children=1:failed:0t:model unavailable or unauthenticated, 2:failed:0t:model unavailable or unauthenticated; outcome=both agents failed",
  ]);
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
    terminalWorkflowFailureDisprovesOwnershipBlock("wf-6 already owns this task", state),
    false,
  );
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
    restoreWorkflowAudits([{ type: "custom", customType: WORKFLOW_AUDIT_ENTRY, data: state }]),
    state,
  );
  assert.deepEqual(restoreWorkflowAudits([{ type: "custom", customType: WORKFLOW_AUDIT_ENTRY, data: { workflows: [null] } }]), emptyWorkflowAuditState);
});
