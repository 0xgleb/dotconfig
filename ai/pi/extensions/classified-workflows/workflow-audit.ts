import type { AgentRequest, AgentResult, WorkflowLimits } from "./core.ts";

export const WORKFLOW_AUDIT_ENTRY = "classified-workflows.audit";

export interface ChildAudit {
  readonly index: number;
  readonly requestedModel?: string;
  readonly tools: readonly string[];
  readonly startedAt: number;
  readonly finishedAt: number;
  readonly status: AgentResult["status"];
  readonly usageTokens: number;
  readonly outputCharacters: number;
  readonly reason?: string;
}

export type ChildAuditEvent =
  | {
      readonly kind: "started";
      readonly index: number;
      readonly requestedModel?: string;
      readonly tools: readonly string[];
    }
  | { readonly kind: "finished"; readonly audit: ChildAudit };

export interface WorkflowAudit {
  readonly id: string;
  readonly label: string;
  readonly status: "completed" | "failed" | "cancelled";
  readonly startedAt: number;
  readonly finishedAt: number;
  readonly limits: WorkflowLimits;
  readonly children: readonly ChildAudit[];
  readonly outcome?: string;
}

export interface WorkflowAuditState {
  readonly workflows: readonly WorkflowAudit[];
}

export const emptyWorkflowAuditState: WorkflowAuditState = { workflows: [] };

export const nextWorkflowSequence = (state: WorkflowAuditState): number =>
  state.workflows.reduce((next, { id }) => {
    const sequence = Number(id.match(/^wf-(\d+)$/)?.[1]);
    return Number.isSafeInteger(sequence + 1) && sequence >= 0
      ? Math.max(next, sequence + 1)
      : next;
  }, 1);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const appendWorkflowAudit = (
  state: WorkflowAuditState,
  audit: WorkflowAudit,
): WorkflowAuditState => ({
  workflows: [
    ...state.workflows.filter(({ id }) => id !== audit.id),
    audit,
  ].slice(-50),
});

const boundedEvidenceText = (text: string, limit: number): string =>
  text.replace(/\s+/g, " ").trim().slice(0, limit);

export const workflowAuditEvidence = (state: WorkflowAuditState): string[] =>
  state.workflows.slice(-8).map((workflow) => {
    const children =
      workflow.children.length === 0
        ? "none"
        : workflow.children
            .map((child) => {
              const reason = child.reason
                ? `:${boundedEvidenceText(child.reason, 160)}`
                : "";
              return `${child.index}:${child.status}:${child.usageTokens}t${reason}`;
            })
            .join(", ");
    const outcome = workflow.outcome
      ? `; outcome=${boundedEvidenceText(workflow.outcome, 240)}`
      : "";
    return `typed workflow audit: ${workflow.id} status=${workflow.status}; children=${children}${outcome}`;
  });

export const terminalWorkflowFailureDisprovesOwnershipBlock = (
  reason: string,
  state: WorkflowAuditState,
): boolean => {
  if (!/\b(?:already owns?|duplicate(?:d)?|ownership)\b/i.test(reason))
    return false;
  const workflowIds = new Set(
    reason.match(/\bwf-\d+\b/gi)?.map((id) => id.toLowerCase()) ?? [],
  );
  if (workflowIds.size === 0) return false;
  return state.workflows.some(
    (workflow) =>
      workflowIds.has(workflow.id.toLowerCase()) &&
      (workflow.status === "failed" ||
        workflow.status === "cancelled" ||
        workflow.children.some((child) => child.status !== "completed")),
  );
};

const finiteInteger = (value: unknown): value is number =>
  Number.isSafeInteger(value) && Number(value) >= 0;

const decodeChildAudit = (value: unknown): ChildAudit | undefined => {
  if (
    !isRecord(value) ||
    !finiteInteger(value.index) ||
    !finiteInteger(value.startedAt) ||
    !finiteInteger(value.finishedAt)
  )
    return undefined;
  if (
    !Array.isArray(value.tools) ||
    !value.tools.every((tool) => typeof tool === "string")
  )
    return undefined;
  if (
    !finiteInteger(value.usageTokens) ||
    !finiteInteger(value.outputCharacters)
  )
    return undefined;
  if (
    value.status !== "completed" &&
    value.status !== "blocked" &&
    value.status !== "failed" &&
    value.status !== "timed-out"
  )
    return undefined;
  if (
    value.requestedModel !== undefined &&
    typeof value.requestedModel !== "string"
  )
    return undefined;
  if (value.reason !== undefined && typeof value.reason !== "string")
    return undefined;
  return {
    index: value.index,
    ...(value.requestedModel ? { requestedModel: value.requestedModel } : {}),
    tools: value.tools,
    startedAt: value.startedAt,
    finishedAt: value.finishedAt,
    status: value.status,
    usageTokens: value.usageTokens,
    outputCharacters: value.outputCharacters,
    ...(value.reason ? { reason: value.reason } : {}),
  };
};

const decodeWorkflowAudit = (value: unknown): WorkflowAudit | undefined => {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    typeof value.label !== "string"
  )
    return undefined;
  if (
    value.status !== "completed" &&
    value.status !== "failed" &&
    value.status !== "cancelled"
  )
    return undefined;
  if (
    !finiteInteger(value.startedAt) ||
    !finiteInteger(value.finishedAt) ||
    !isRecord(value.limits)
  )
    return undefined;
  const limits = value.limits;
  if (
    ![
      limits.maxAgents,
      limits.concurrency,
      limits.agentTimeoutMs,
      limits.workflowTimeoutMs,
      limits.retries,
      limits.tokenBudget,
    ].every(finiteInteger)
  )
    return undefined;
  if (!Array.isArray(value.children) || value.children.length > 256)
    return undefined;
  const children = value.children.map(decodeChildAudit);
  if (children.some((child) => child === undefined)) return undefined;
  if (value.outcome !== undefined && typeof value.outcome !== "string")
    return undefined;
  return {
    id: value.id,
    label: value.label,
    status: value.status,
    startedAt: value.startedAt,
    finishedAt: value.finishedAt,
    limits: {
      maxAgents: limits.maxAgents,
      concurrency: limits.concurrency,
      agentTimeoutMs: limits.agentTimeoutMs,
      workflowTimeoutMs: limits.workflowTimeoutMs,
      retries: limits.retries,
      tokenBudget: limits.tokenBudget,
    },
    children: children.filter(
      (child): child is ChildAudit => child !== undefined,
    ),
    ...(value.outcome ? { outcome: value.outcome } : {}),
  };
};

export const restoreWorkflowAudits = (
  entries: readonly unknown[],
): WorkflowAuditState => {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (
      !isRecord(entry) ||
      entry.type !== "custom" ||
      entry.customType !== WORKFLOW_AUDIT_ENTRY ||
      !isRecord(entry.data)
    )
      continue;
    if (
      !Array.isArray(entry.data.workflows) ||
      entry.data.workflows.length > 50
    )
      continue;
    const workflows = entry.data.workflows.map(decodeWorkflowAudit);
    if (workflows.some((workflow) => workflow === undefined)) continue;
    return {
      workflows: workflows.filter(
        (workflow): workflow is WorkflowAudit => workflow !== undefined,
      ),
    };
  }
  return emptyWorkflowAuditState;
};

export const auditedAgentRunner = (
  runAgent: (
    request: AgentRequest,
    signal: AbortSignal,
    tokenLimit?: number,
  ) => Promise<AgentResult>,
  audits: ChildAudit[],
  sanitize: (text: string) => string,
  onEvent?: (event: ChildAuditEvent) => void,
): ((
  request: AgentRequest,
  signal: AbortSignal,
  tokenLimit: number,
) => Promise<AgentResult>) => {
  let nextIndex = 1;
  return async (request, signal, tokenLimit) => {
    const index = nextIndex++;
    const startedAt = Date.now();
    const tools = request.tools ?? ["read", "grep", "find", "ls"];
    onEvent?.({
      kind: "started",
      index,
      ...(request.model ? { requestedModel: request.model } : {}),
      tools,
    });
    try {
      const result = await runAgent(request, signal, tokenLimit);
      const audit: ChildAudit = {
        index,
        ...(request.model ? { requestedModel: request.model } : {}),
        tools,
        startedAt,
        finishedAt: Date.now(),
        status: result.status,
        usageTokens: result.usageTokens,
        outputCharacters: result.output.length,
        ...(result.status === "completed"
          ? {}
          : { reason: sanitize(result.reason).slice(0, 1_000) }),
      };
      audits.push(audit);
      onEvent?.({ kind: "finished", audit });
      return result;
    } catch (error) {
      const audit: ChildAudit = {
        index,
        ...(request.model ? { requestedModel: request.model } : {}),
        tools,
        startedAt,
        finishedAt: Date.now(),
        status: "failed",
        usageTokens: 0,
        outputCharacters: 0,
        reason: sanitize(
          error instanceof Error ? error.message : "Agent failed",
        ).slice(0, 1_000),
      };
      audits.push(audit);
      onEvent?.({ kind: "finished", audit });
      throw error;
    }
  };
};
