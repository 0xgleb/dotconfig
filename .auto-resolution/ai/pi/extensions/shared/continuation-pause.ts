export const CONTINUATION_PAUSE_ENTRY = "pi.continuation-pause"

export interface ContinuationPauseState {
  readonly paused: boolean
  readonly updatedAt: number
}

const isRecord: (
  value: unknown,
) => value is Readonly<Record<string, unknown>> = value =>
  typeof value === "object" && value !== null && !Array.isArray(value)

export const parseContinuationPause: (
  value: unknown,
) => ContinuationPauseState | undefined = value => {
  if (
    !isRecord(value) ||
    typeof value.paused !== "boolean" ||
    !Number.isFinite(value.updatedAt)
  )
    return undefined
  return { paused: value.paused, updatedAt: Number(value.updatedAt) }
}

export const latestContinuationPause: (
  entries: readonly unknown[],
) => ContinuationPauseState | undefined = entries => {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]
    if (
      !isRecord(entry) ||
      entry.type !== "custom" ||
      entry.customType !== CONTINUATION_PAUSE_ENTRY
    )
      continue
    return parseContinuationPause(entry.data)
  }
  return undefined
}

export const isContinuationPaused: (
  entries: readonly unknown[],
) => boolean = entries => latestContinuationPause(entries)?.paused === true

export const wasRunAborted: (
  messages: readonly unknown[],
) => boolean = messages => {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (!isRecord(message) || message.role !== "assistant") continue
    return message.stopReason === "aborted"
  }
  return false
}
