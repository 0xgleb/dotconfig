import type { Decision } from "./core.ts"

export const ACTION_REMEDIATION_ENTRY =
  "classified-workflows.action-remediation"

export interface PendingActionRemediation {
  readonly status: "pending"
  readonly toolName: string
  readonly reason: string
  readonly requestedAt: number
}

export interface ResolvedActionRemediation {
  readonly status: "resolved"
  readonly toolName: string
  readonly resolvedAt: number
}

export type ActionRemediationState =
  | PendingActionRemediation
  | ResolvedActionRemediation

export interface ActionRemediationInterruption {
  readonly block: true
  readonly reason: string
  readonly remediation: PendingActionRemediation
}

export interface ActionAttemptResult {
  readonly toolName: string
  readonly outcome: "succeeded" | "failed"
  readonly finishedAt: number
}

export const remediationForDecision = (
  toolName: string,
  decision: Decision,
  requestedAt: number,
): PendingActionRemediation | undefined =>
  decision.verdict === "remediate"
    ? {
        status: "pending",
        toolName,
        reason: decision.reason,
        requestedAt,
      }
    : undefined

export const remediationInterruption = (
  remediation: PendingActionRemediation,
): ActionRemediationInterruption => ({
  block: true,
  reason:
    `${remediation.toolName === "deliver_stakeholder_update" ? "Delivery" : "Action"} verification required: ${remediation.reason}. ` +
    "This is unfinished work, not a denial of the explicit delivery request.",
  remediation,
})

export const remediationContinuationMessage = (
  remediation: PendingActionRemediation,
): string =>
  `The requested ${remediation.toolName} action is still pending: ${remediation.reason}. ` +
  `Verify the missing facts, correct the draft, and retry ${remediation.toolName} now. ` +
  "If verification genuinely cannot be completed, report the exact blocker to the .config agent. Do not stop or wait silently."

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const parseActionRemediationState = (
  value: unknown,
): ActionRemediationState | undefined => {
  if (
    !isRecord(value) ||
    typeof value.toolName !== "string" ||
    value.toolName.length === 0 ||
    value.toolName.length > 128
  ) {
    return undefined
  }
  if (
    value.status === "pending" &&
    typeof value.reason === "string" &&
    value.reason.length > 0 &&
    value.reason.length <= 2_000 &&
    Number.isSafeInteger(value.requestedAt) &&
    Number(value.requestedAt) >= 0
  ) {
    return {
      status: "pending",
      toolName: value.toolName,
      reason: value.reason,
      requestedAt: Number(value.requestedAt),
    }
  }
  if (
    value.status === "resolved" &&
    Number.isSafeInteger(value.resolvedAt) &&
    Number(value.resolvedAt) >= 0
  ) {
    return {
      status: "resolved",
      toolName: value.toolName,
      resolvedAt: Number(value.resolvedAt),
    }
  }
  return undefined
}

export const restorePendingActionRemediation = (
  entries: readonly unknown[],
): PendingActionRemediation | undefined => {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]
    if (
      !isRecord(entry) ||
      entry.type !== "custom" ||
      entry.customType !== ACTION_REMEDIATION_ENTRY
    ) {
      continue
    }
    const state = parseActionRemediationState(entry.data)
    if (!state) continue
    return state.status === "pending" ? state : undefined
  }
  return undefined
}

export const resolvedActionRemediation = (
  toolName: string,
  resolvedAt: number,
): ResolvedActionRemediation => ({ status: "resolved", toolName, resolvedAt })

export const reconcileActionRemediation = (
  pending: PendingActionRemediation | undefined,
  result: ActionAttemptResult,
): ResolvedActionRemediation | undefined =>
  pending &&
  pending.toolName === result.toolName &&
  result.outcome === "succeeded"
    ? resolvedActionRemediation(result.toolName, result.finishedAt)
    : undefined
