import assert from "node:assert/strict";
import test from "node:test";
import type { AgentResult, WorkflowLimits } from "./core.ts";
import {
  WORKFLOW_AUDIT_ENTRY,
  appendWorkflowAudit,
  auditedAgentRunner,
  emptyWorkflowAuditState,
  restoreWorkflowAudits,
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
