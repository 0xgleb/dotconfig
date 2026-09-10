export const CAPABILITY_CIRCUIT_ENTRY =
  "classified-workflows.capability-circuit"

export interface CapabilityCircuitState {
  readonly consecutiveBlockers: number
  readonly open: boolean
  readonly updatedAt: number
}

export const emptyCapabilityCircuit: CapabilityCircuitState = {
  consecutiveBlockers: 0,
  open: false,
  updatedAt: 0,
}

export const decodeCapabilityCircuit = (
  value: unknown,
): CapabilityCircuitState | undefined => {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    !("consecutiveBlockers" in value) ||
    !("open" in value) ||
    !("updatedAt" in value) ||
    !Number.isSafeInteger(value.consecutiveBlockers) ||
    Number(value.consecutiveBlockers) < 0 ||
    Number(value.consecutiveBlockers) > 2 ||
    typeof value.open !== "boolean" ||
    !Number.isSafeInteger(value.updatedAt) ||
    Number(value.updatedAt) < 0
  )
    return undefined
  const consecutiveBlockers = Number(value.consecutiveBlockers)
  if (value.open !== consecutiveBlockers >= 2) return undefined
  return {
    consecutiveBlockers,
    open: value.open,
    updatedAt: Number(value.updatedAt),
  }
}
