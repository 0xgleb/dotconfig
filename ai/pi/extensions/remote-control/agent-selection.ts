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

// Neither candidate is unique on its own. `basename(cwd)` is shared whenever
// several lanes run inside one repository, and it can also collide with another
// agent's label or with the head of another agent's id, because ids match by
// prefix -- which is the same reason `claude-config-opus-1` selects
// `claude-config-opus-10` as well as itself. Listing a selector that resolves to
// more than one agent is worse than listing none, because `/use` refuses an
// ambiguous match and this list is what the owner copies from. Uniqueness is
// therefore decided with `agentMatchesSelector`, the very predicate `/use`
// resolves with, so the listing and `/use` agree by construction; a narrower
// folder-only comparison would call selectors unique that `/use` then rejects.
export const resolvableSelector = (
  agent: BridgeAgent,
  agents: ReadonlyArray<BridgeAgent>,
): string => {
  const resolvesToExactlyOneAgent = (candidate: string): boolean =>
    agents.filter((other) => agentMatchesSelector(other, candidate)).length === 1
  const candidates = [agentSelector(agent), agent.id]
  return (
    candidates.find((candidate) => resolvesToExactlyOneAgent(candidate)) ??
    agent.id
  )
}

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
            `- ${escapeTelegramHtml(agent.label)} · <code>${escapeTelegramHtml(resolvableSelector(agent, agents))}</code> · session <code>${escapeTelegramHtml(agent.id.slice(0, 8))}</code>${agent.accepting ? "" : " [busy]"}`,
        ),
        `Use <code>/use ${escapeTelegramHtml(resolvableSelector(agents[0]!, agents))}</code> or another listed selector.`,
      ].join("\n")
