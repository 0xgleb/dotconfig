export type TaskContinuationPhase = "idle" | "queued" | "running"

export const canClaimRemoteTurn = (
  hasActiveRemoteTurn: boolean,
  continuationPhase: TaskContinuationPhase,
): boolean => !hasActiveRemoteTurn && continuationPhase === "idle"

export const settleTaskContinuation = (
  phase: TaskContinuationPhase,
): TaskContinuationPhase => (phase === "running" ? "idle" : phase)
