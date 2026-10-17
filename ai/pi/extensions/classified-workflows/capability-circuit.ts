import {
  CAPABILITY_CIRCUIT_ENTRY,
  decodeCapabilityCircuit,
  emptyCapabilityCircuit,
  type CapabilityCircuitState,
} from "../shared/capability-state.ts"
export {
  CAPABILITY_CIRCUIT_ENTRY,
  decodeCapabilityCircuit,
  emptyCapabilityCircuit,
  type CapabilityCircuitState,
} from "../shared/capability-state.ts"

export type CapabilityOutcome = "tool-used" | "capability-blocked" | "other"

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const messageParts = (message: Record<string, unknown>): readonly unknown[] =>
  Array.isArray(message.content) ? message.content : [message.content]

export const capabilityOutcome = (
  messages: readonly unknown[],
): CapabilityOutcome => {
  let assistantText = ""
  for (const candidate of messages) {
    if (!isRecord(candidate)) continue
    const message =
      candidate.type === "message" && isRecord(candidate.message)
        ? candidate.message
        : candidate
    if (message.role !== "assistant") continue
    for (const part of messageParts(message)) {
      if (isRecord(part) && part.type === "toolCall") return "tool-used"
      if (typeof part === "string") assistantText += ` ${part}`
      else if (
        isRecord(part) &&
        part.type === "text" &&
        typeof part.text === "string"
      ) {
        assistantText += ` ${part.text}`
      }
    }
  }

  return /(?:tools? (?:are |remain |seem )?(?:disabled|unavailable)|cannot (?:use|access) (?:the )?tools?|communication-only (?:restriction|turn))/i.test(
    assistantText,
  )
    ? "capability-blocked"
    : "other"
}

export const advanceCapabilityCircuit = (
  state: CapabilityCircuitState,
  outcome: CapabilityOutcome,
  now: number,
): CapabilityCircuitState => {
  if (outcome === "tool-used") {
    return { consecutiveBlockers: 0, open: false, updatedAt: now }
  }
  if (outcome === "capability-blocked") {
    const consecutiveBlockers = Math.min(2, state.consecutiveBlockers + 1)
    return {
      consecutiveBlockers,
      open: consecutiveBlockers >= 2,
      updatedAt: now,
    }
  }
  return state
}

export const restoreCapabilityCircuit = (
  entries: readonly unknown[],
): CapabilityCircuitState => {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]
    if (
      isRecord(entry) &&
      entry.type === "custom" &&
      entry.customType === CAPABILITY_CIRCUIT_ENTRY
    ) {
      return decodeCapabilityCircuit(entry.data) ?? emptyCapabilityCircuit
    }
  }
  return emptyCapabilityCircuit
}
