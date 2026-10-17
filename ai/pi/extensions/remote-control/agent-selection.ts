import { basename } from "node:path"
import { workDeliveryAcceptsInbox, type BridgeAgent } from "./protocol.ts"

const escapeTelegramHtml = (value: string): string =>
  value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")

// Registration states delivery capability explicitly. Agent-id shape is only
// identity and can never imply that a lane drains inboxes or is safe to expose
// as an owner chat target.
export const telegramRoutableAgents = (
  agents: ReadonlyArray<BridgeAgent>,
): readonly BridgeAgent[] =>
  agents.filter(({ workDelivery }) => workDelivery === "native-pi")

export const bridgeQueueRoutableAgents = (
  agents: ReadonlyArray<BridgeAgent>,
): readonly BridgeAgent[] =>
  agents.filter(({ workDelivery }) => workDeliveryAcceptsInbox(workDelivery))

export const agentSelector = (agent: BridgeAgent): string =>
  basename(agent.cwd) || agent.label

export const agentMatchesSelector = (
  agent: BridgeAgent,
  requested: string,
): boolean =>
  agent.label === requested ||
  agentSelector(agent) === requested ||
  agent.id.startsWith(requested)

// `basename(cwd)` is not unique: several lanes run inside one repository, so
// four agents can all present `.config`. Listing a selector that resolves to
// more than one agent is worse than listing none, because `/use` refuses an
// ambiguous match and this list is what the owner copies from.
export const resolvableSelector = (
  agent: BridgeAgent,
  agents: ReadonlyArray<BridgeAgent>,
): string => {
  const folder = agentSelector(agent)
  const sharesFolder =
    agents.filter(other => agentSelector(other) === folder).length > 1
  return sharesFolder ? agent.id : folder
}

export const preferredAgent = (
  agents: ReadonlyArray<BridgeAgent>,
  selectedAgentId?: string,
): BridgeAgent | undefined => {
  const selected = agents.find(({ id }) => id === selectedAgentId)
  const dotconfig = agents.find(agent => agentSelector(agent) === ".config")
  const yielduck = agents.find(agent => agentSelector(agent) === "yielduck")
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
          agent =>
            `- ${escapeTelegramHtml(agent.label)} · <code>${escapeTelegramHtml(resolvableSelector(agent, agents))}</code> · session <code>${escapeTelegramHtml(agent.id.slice(0, 8))}</code>${agent.accepting ? "" : " [busy]"}`,
        ),
        `Use <code>/use ${escapeTelegramHtml(resolvableSelector(agents[0]!, agents))}</code> or another listed selector.`,
      ].join("\n")
