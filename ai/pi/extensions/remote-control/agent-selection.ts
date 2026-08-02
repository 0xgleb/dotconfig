import { basename } from "node:path"
import type { BridgeAgent } from "./protocol.ts"

const escapeTelegramHtml = (value: string): string =>
  value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")

export const agentSelector = (agent: BridgeAgent): string =>
  basename(agent.cwd) || agent.label

export const agentMatchesSelector = (
  agent: BridgeAgent,
  requested: string,
): boolean =>
  agent.label === requested ||
  agentSelector(agent) === requested ||
  agent.id.startsWith(requested)

export const preferredAgent = (
  agents: ReadonlyArray<BridgeAgent>,
  selectedAgentId?: string,
): BridgeAgent | undefined => {
  const selected = agents.find(({ id }) => id === selectedAgentId)
  const dotconfig = agents.find((agent) => agentSelector(agent) === ".config")
  const yielduck = agents.find((agent) => agentSelector(agent) === "yielduck")
  const accepting = agents.filter(({ accepting }) => accepting)
  return (
    selected ??
    dotconfig ??
    yielduck ??
    (accepting.length === 1 ? accepting[0] : undefined)
  )
}

export const agentListHtml = (agents: ReadonlyArray<BridgeAgent>): string =>
  agents.length === 0
    ? "No Pi agents are bridge-ready right now."
    : [
        "Bridge-ready Pi agents:",
        ...agents.map(
          (agent) =>
            `- ${escapeTelegramHtml(agent.label)} · <code>${escapeTelegramHtml(agentSelector(agent))}</code> · session <code>${escapeTelegramHtml(agent.id.slice(0, 8))}</code>${agent.accepting ? "" : " [busy]"}`,
        ),
        "Use <code>/use .config</code> or another listed label.",
      ].join("\n")
