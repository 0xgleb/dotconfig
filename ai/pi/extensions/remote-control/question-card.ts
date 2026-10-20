import type { BridgeQuestion } from "./protocol.ts"
import { telegramHtml } from "./telegram-format.ts"

/** Shared by initial relay and presentation-only edits of an existing card. */
export const questionCardHtml = (
  question: BridgeQuestion,
  agentLabel: string,
): string => {
  const title = question.header
    ? `❓ ${question.header}`
    : "❓ Pi needs your answer"
  const choices = question.options?.map(
    (option, index) =>
      `${index + 1}. ${option.label}${option.description ? ` — ${option.description}` : ""}`,
  )
  const body = [
    title,
    `Agent: ${agentLabel}`,
    `Question q${question.questionId}`,
    "",
    question.question,
    ...(choices ? ["", ...choices] : []),
    ...(question.guess ? ["", `Suggested: ${question.guess}`] : []),
  ]
    .join("\n")
    .slice(0, 4_000 - 120)
  return telegramHtml(
    `${body}\n\nReply directly to this message to answer only q${question.questionId}.`,
  )
}
