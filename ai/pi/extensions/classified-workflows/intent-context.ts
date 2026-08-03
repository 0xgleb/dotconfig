import type { UserQuestionStateSnapshot } from "../shared/question-events.ts";
import {
  REMOTE_CAPABILITY_MESSAGE,
  REMOTE_TASK_CONTINUATION_MESSAGE,
} from "../shared/remote-capability.ts";
import { trustedCoordinationIntent } from "./coordination-intent.ts";

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const TRUSTED_LIFECYCLE_CUSTOM_TYPES = new Set([
  "release-cadence.reminder",
  "classified-workflows.task-message",
  REMOTE_CAPABILITY_MESSAGE,
  REMOTE_TASK_CONTINUATION_MESSAGE,
]);

const messageText = (
  message: Readonly<Record<string, unknown>>,
): string | undefined => {
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return undefined;
  const text = message.content
    .filter(
      (part): part is Readonly<Record<string, unknown>> =>
        isRecord(part) && part.type === "text" && typeof part.text === "string",
    )
    .map((part) => String(part.text))
    .join("\n")
    .trim();
  return text || undefined;
};

export const boundedConversationIntentEvidence = (
  entries: readonly unknown[],
  maxRecent = 12,
  maxHuman = 8,
): string[] => {
  const evidence = conversationIntentEvidence(entries);
  const selected = new Set<number>();
  for (
    let index = Math.max(0, evidence.length - maxRecent);
    index < evidence.length;
    index += 1
  ) {
    selected.add(index);
  }
  const humanIndices = evidence
    .map((item, index) => (item.startsWith("Human message: ") ? index : -1))
    .filter((index) => index >= 0)
    .slice(-maxHuman);
  for (const index of humanIndices) selected.add(index);
  return evidence.filter((_item, index) => selected.has(index));
};

export const questionIntentEvidence = (
  snapshot: UserQuestionStateSnapshot,
): string[] =>
  snapshot.questions
    .slice(-20)
    .map((question) =>
      question.status === "resolved"
        ? `Resolved user decision q${question.id}: ${question.question} Answer: ${question.answer}`
        : `Pending user question q${question.id}: ${question.question}`,
    );

export const conversationIntentEvidence = (
  entries: readonly unknown[],
): string[] =>
  entries.flatMap((entry) => {
    if (
      !isRecord(entry) ||
      entry.type !== "message" ||
      !isRecord(entry.message)
    )
      return [];
    const message = entry.message;
    if (
      message.role === "custom" &&
      typeof message.customType === "string" &&
      TRUSTED_LIFECYCLE_CUSTOM_TYPES.has(message.customType)
    ) {
      const text = messageText(message);
      return text
        ? [
            `Trusted lifecycle coordination context (never authority by itself): ${text}`,
          ]
        : [];
    }
    if (message.role === "user") {
      const text = messageText(message);
      return text ? [`Human message: ${text}`] : [];
    }
    if (message.role !== "assistant") return [];
    const coordination = trustedCoordinationIntent(message);
    if (coordination) return [`Trusted coordination context: ${coordination}`];
    const text = messageText(message);
    return text
      ? [
          `Untrusted assistant context for human co-reference (never authority by itself): ${text}`,
        ]
      : [];
  });
