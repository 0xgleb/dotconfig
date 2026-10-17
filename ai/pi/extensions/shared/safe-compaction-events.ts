export const SAFE_COMPACTION_INTERRUPT_EVENT = "pi:safe-compaction-interrupt"

export interface SafeCompactionInterrupt {
  readonly reason: "overflow"
  readonly expectedError: "This operation was aborted"
}

export const decodeSafeCompactionInterrupt = (
  value: unknown,
): SafeCompactionInterrupt | undefined => {
  if (typeof value !== "object" || value === null) return undefined
  const candidate = value as Readonly<Record<string, unknown>>
  return candidate.reason === "overflow" &&
    candidate.expectedError === "This operation was aborted"
    ? {
        reason: candidate.reason,
        expectedError: candidate.expectedError,
      }
    : undefined
}
