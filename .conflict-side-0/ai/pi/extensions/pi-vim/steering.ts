export type StreamingSubmissionMode =
  | "pass"
  | "immediate"
  | "steer"
  | "followUp"

export const isSlashCommandInput = (text: string): boolean =>
  text.trimStart().startsWith("/")

/**
 * Select delivery before the host receives a custom-editor submission.
 * Ordinary Enter is additive while streaming; Ctrl+Enter is the explicit
 * interrupt. Idle submissions run immediately because no queue exists.
 */
export const streamingSubmissionMode = (input: {
  readonly text: string
  readonly isStreaming: boolean
  readonly isEnter: boolean
  readonly isCtrlEnter: boolean
}): StreamingSubmissionMode => {
  if (!input.isEnter && !input.isCtrlEnter) return "pass"
  if (input.text.trim().length === 0) return "pass"
  if (!input.isStreaming) return input.isCtrlEnter ? "immediate" : "pass"
  if (isSlashCommandInput(input.text))
    return input.isCtrlEnter ? "immediate" : "pass"
  return input.isCtrlEnter ? "steer" : "followUp"
}
