import type { BridgeAgent } from "./protocol.ts"

export interface AgentRoleIdentity {
  readonly role: string
  readonly mode: "task" | "operational"
}

const titleWord = (word: string): string => {
  const normalized = word.toLowerCase()
  if (normalized === "pi") return "Pi"
  if (normalized === "st0x") return "ST0x"
  return normalized
    ? `${normalized[0]?.toUpperCase()}${normalized.slice(1)}`
    : ""
}

const titleLabel = (label: string): string =>
  label === ".config"
    ? "Dotconfig"
    : label
        .split(/[-_\s]+/u)
        .map(titleWord)
        .filter(Boolean)
        .join(" ")

export const agentDisplayLabel = (
  baseLabel: string,
  roles: readonly AgentRoleIdentity[],
): string => {
  const project = titleLabel(baseLabel)
  const role = [...roles].sort((left, right) => {
    if (left.mode !== right.mode) return left.mode === "operational" ? -1 : 1
    return left.role.localeCompare(right.role)
  })[0]
  if (!role) return project
  const roleLabel = titleLabel(role.role)
  return project.toLowerCase().includes(roleLabel.toLowerCase())
    ? project
    : `${project} · ${roleLabel}`
}

export const identifiedAgentLabel = (
  agent: BridgeAgent,
  agents: readonly BridgeAgent[],
): string => {
  const duplicates = agents
    .filter(({ label }) => label === agent.label)
    .sort((left, right) => left.id.localeCompare(right.id))
  if (duplicates.length < 2) return agent.label
  const index = duplicates.findIndex(({ id }) => id === agent.id)
  return `${agent.label} · Instance ${Math.max(0, index) + 1}`
}
