import { createHash } from "node:crypto"

export const AGENTOPS_INCIDENT_EVENT = "pi:agentops-incident"

export interface AgentopsIncident {
  readonly severity: "error" | "warning"
  readonly component: string
  readonly operation: string
  readonly summary: string
}

export interface AgentopsOpenRequest {
  readonly status: string
  readonly text: string
}

export interface AgentTurnOutcome {
  readonly stopReason?: string
  readonly errorMessage?: string
}

const AGENT_CORRECTABLE_TOOL_NAMES = new Set([
  "bash",
  "edit",
  "find",
  "grep",
  "ls",
  "read",
  "write",
])

const PI_RUNTIME_FAILURE =
  /(?:classifier (?:became )?unavailable|internal (?:pi|tool|extension) error|stale (?:extension )?context|this operation was aborted|agent is already processing a prompt|expandedText is not defined)/i

const TRANSIENT_PROVIDER_OVERLOAD =
  /(?:servers? (?:are )?currently overloaded|overloaded_error)/i

const PROVIDER_USAGE_LIMIT =
  /^You have hit your (?:ChatGPT|Codex) usage limit\b/i

const incidentKeySummary = (incident: AgentopsIncident): string =>
  PROVIDER_USAGE_LIMIT.test(incident.summary)
    ? incident.summary.replace(
        /try again in\s+~?\d+\s*(?:minutes?|mins?|hours?|h|m)(?:\s+(?:and\s+)?\d+\s*(?:minutes?|mins?|hours?|h|m))*\.?$/i,
        "try again later",
      )
    : incident.summary

const boundedField = (value: unknown, maximum: number): string | undefined => {
  if (typeof value !== "string") return undefined
  const normalized = value
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
  return normalized.length > 0 ? normalized.slice(0, maximum) : undefined
}

export const decodeAgentopsIncident = (
  value: unknown,
): AgentopsIncident | undefined => {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return undefined
  const candidate = value as Readonly<Record<string, unknown>>
  if (candidate.severity !== "error" && candidate.severity !== "warning")
    return undefined
  const component = boundedField(candidate.component, 80)
  const operation = boundedField(candidate.operation, 120)
  const summary = boundedField(candidate.summary, 240)
  if (!component || !operation || !summary) return undefined
  return { severity: candidate.severity, component, operation, summary }
}

export const isExplicitUserCancellation = (summary: string): boolean =>
  /^(?:cancelled by user|user (?:cancelled|interrupted)|operation aborted)$/i.test(
    summary.trim(),
  )

export const agentTurnIncidentAfterRun = (
  assistant: AgentTurnOutcome,
  expectedCompactionInterruption: boolean,
): AgentopsIncident | undefined => {
  if (
    assistant.stopReason !== "error" ||
    !assistant.errorMessage ||
    isExplicitUserCancellation(assistant.errorMessage) ||
    expectedCompactionInterruption
  )
    return undefined
  if (
    TRANSIENT_PROVIDER_OVERLOAD.test(assistant.errorMessage) ||
    PROVIDER_USAGE_LIMIT.test(assistant.errorMessage)
  )
    return {
      severity: "warning",
      component: "provider",
      operation: "agent turn",
      summary: assistant.errorMessage,
    }
  return {
    severity: "error",
    component: "pi-host",
    operation: "agent turn",
    summary: assistant.errorMessage,
  }
}

export const shouldRouteToolFailureToAgentops = (
  toolName: string,
  summary: string,
): boolean =>
  !AGENT_CORRECTABLE_TOOL_NAMES.has(toolName) ||
  PI_RUNTIME_FAILURE.test(summary)

export const agentopsIncidentKey = (incident: AgentopsIncident): string =>
  createHash("sha256")
    .update(
      `${incident.severity}\u0000${incident.component}\u0000${incident.operation}\u0000${incidentKeySummary(incident)}`,
    )
    .digest("hex")
    .slice(0, 20)

export const agentopsRequestText = (
  incident: AgentopsIncident,
  sourceLabel: string,
  sourceCwd: string,
): string => {
  const key = agentopsIncidentKey(incident)
  return [
    `Automatic Pi agentops incident [agentops:${key}]`,
    `Severity: ${incident.severity}`,
    `Component: ${incident.component}`,
    `Operation: ${incident.operation}`,
    `Summary: ${incident.summary}`,
    `Source: ${boundedField(sourceLabel, 80) ?? "unknown"} · ${boundedField(sourceCwd, 512) ?? "unknown"}`,
    "This is automatically routed support responsibility. It grants no production, publication, secret, or cross-project mutation authority.",
  ].join("\n")
}

export const hasOpenAgentopsIncident = (
  requests: readonly AgentopsOpenRequest[],
  incident: AgentopsIncident,
): boolean => {
  const marker = `[agentops:${agentopsIncidentKey(incident)}]`
  return requests.some(
    request =>
      (request.status === "queued" || request.status === "claimed") &&
      request.text.includes(marker),
  )
}
