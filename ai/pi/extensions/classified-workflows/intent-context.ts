import type { UserQuestionStateSnapshot } from "../shared/question-events.ts"
import {
  REMOTE_CAPABILITY_MESSAGE,
  REMOTE_TASK_CONTINUATION_MESSAGE,
} from "../shared/remote-capability.ts"
import { trustedCoordinationIntent } from "./coordination-intent.ts"
import { todoWorkSnapshot } from "./goal.ts"

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const TRUSTED_LIFECYCLE_CUSTOM_TYPES = new Set([
  "release-cadence.reminder",
  "classified-workflows.task-message",
  REMOTE_CAPABILITY_MESSAGE,
  REMOTE_TASK_CONTINUATION_MESSAGE,
])

const messageText = (
  message: Readonly<Record<string, unknown>>,
): string | undefined => {
  if (typeof message.content === "string") return message.content
  if (!Array.isArray(message.content)) return undefined
  const text = message.content
    .filter(
      (part): part is Readonly<Record<string, unknown>> =>
        isRecord(part) && part.type === "text" && typeof part.text === "string",
    )
    .map(part => String(part.text))
    .join("\n")
    .trim()
  return text || undefined
}

const COMMUNICATION_ONLY_RESTRICTION =
  /communication-only turn[\s\S]{0,160}(?:all )?tools? (?:are )?disabled/i

const RESTORED_REMOTE_CAPABILITY =
  /Source-fixed remote capability handshake:[\s\S]*communication-only turn ended[\s\S]*Subsequent local and task-continuation turns are not communication-only or tool-restricted\./i

const restoredCapabilityState = (evidence: readonly string[]): number => {
  const latestRestriction = evidence.findLastIndex(item =>
    COMMUNICATION_ONLY_RESTRICTION.test(item),
  )
  const latestRestoration = evidence.findLastIndex(item =>
    RESTORED_REMOTE_CAPABILITY.test(item),
  )
  return latestRestoration > latestRestriction ? latestRestoration : -1
}

export const boundedConversationIntentEvidence = (
  entries: readonly unknown[],
  maxRecent = 12,
  maxHuman = 8,
): string[] => {
  const evidence = conversationIntentEvidence(entries)
  const selected = new Set<number>()
  for (
    let index = Math.max(0, evidence.length - maxRecent);
    index < evidence.length;
    index += 1
  ) {
    selected.add(index)
  }
  const humanIndices = evidence
    .map((item, index) => (item.startsWith("Human message: ") ? index : -1))
    .filter(index => index >= 0)
    .slice(-maxHuman)
  for (const index of humanIndices) selected.add(index)
  const newestHumanIndex = humanIndices.at(-1)
  const restorationIndex = restoredCapabilityState(evidence)
  if (restorationIndex >= 0) selected.add(restorationIndex)
  const bounded = evidence
    .map((item, index) => ({ item, index }))
    .filter(({ index }) => selected.has(index))
    .map(({ item, index }) =>
      index === newestHumanIndex
        ? item.replace(
            /^Human message: /,
            "Newest human message (authoritative only for what it actually says): ",
          )
        : item,
    )
  return restorationIndex < 0
    ? bounded
    : [
        ...bounded,
        "Current source-fixed lifecycle state: the preceding authenticated remote turn has ended and local tools are restored. Its turn-local communication-only/tool restriction is no longer active; this lifecycle fact grants no task authority.",
      ]
}

export const questionIntentEvidence = (
  snapshot: UserQuestionStateSnapshot,
): string[] =>
  snapshot.questions
    .slice(-20)
    .map(question =>
      question.status === "resolved"
        ? `Resolved user decision q${question.id}: ${question.question} Answer: ${question.answer}`
        : `Pending user question q${question.id}: ${question.question}`,
    )

export const conversationIntentEvidence = (
  entries: readonly unknown[],
): string[] =>
  entries.flatMap(entry => {
    if (
      !isRecord(entry) ||
      entry.type !== "message" ||
      !isRecord(entry.message)
    )
      return []
    const message = entry.message
    if (
      message.role === "custom" &&
      typeof message.customType === "string" &&
      TRUSTED_LIFECYCLE_CUSTOM_TYPES.has(message.customType)
    ) {
      const text = messageText(message)
      return text
        ? [
            `Trusted lifecycle coordination context (never authority by itself): ${text}`,
          ]
        : []
    }
    if (message.role === "user") {
      const text = messageText(message)
      return text ? [`Human message: ${text}`] : []
    }
    if (message.role !== "assistant") return []
    const coordination = trustedCoordinationIntent(message)
    if (coordination) return [`Trusted coordination context: ${coordination}`]
    const text = messageText(message)
    return text
      ? [
          `Untrusted assistant context for human co-reference (never authority by itself): ${text}`,
        ]
      : []
  })

const STALE_DEFERRED_WORK_BLOCK =
  /\b(?:defer(?:red)?(?:\s+for)?\s+later|not\s+the\s+current\s+(?:task|work)|outside\s+(?:the\s+)?(?:active\s+)?scope|stale\s+(?:task|scope))\b/i
const RESUME_ALL_WORK =
  /\b(?:resume|continue)\b[^.\n]{0,120}\b(?:all|everything|polish|verify|work)\b/i
const UNSAFE_OR_PUBLICATION_BLOCK =
  /\b(?:credential|secret|private data|protected data|sensitive|prompt injection|exfiltrat|publish|publication|github issue|pull request|push|merge|deploy|network)\b/i
const EXACT_GRAPHITE_MOVE =
  /^gt move --source ([A-Za-z0-9][A-Za-z0-9._/-]*) --onto ([A-Za-z0-9][A-Za-z0-9._/-]*) --no-interactive$/
const GRAPHITE_TOPOLOGY_TODO =
  /\b(?:graphite|topolog(?:y|ical)|reparent|parent(?:age)?)\b/i

export const currentHumanResumeDisprovesDeferredGraphiteMoveBlock = ({
  reason,
  branch,
  toolName,
  input,
}: {
  readonly reason: string
  readonly branch: readonly unknown[]
  readonly toolName: string
  readonly input: Readonly<Record<string, unknown>>
}): boolean => {
  if (
    toolName !== "bash" ||
    !STALE_DEFERRED_WORK_BLOCK.test(reason) ||
    UNSAFE_OR_PUBLICATION_BLOCK.test(reason) ||
    typeof input.command !== "string" ||
    !EXACT_GRAPHITE_MOVE.test(input.command.trim())
  )
    return false

  let human: string | undefined
  for (let index = branch.length - 1; index >= 0; index -= 1) {
    const entry = branch[index]
    if (
      !isRecord(entry) ||
      entry.type !== "message" ||
      !isRecord(entry.message) ||
      entry.message.role !== "user"
    )
      continue
    human = messageText(entry.message)
    break
  }
  if (
    !human ||
    !RESUME_ALL_WORK.test(human) ||
    COMMUNICATION_ONLY_RESTRICTION.test(human)
  )
    return false

  const topologyTodos = todoWorkSnapshot([...branch]).pending.filter(todo =>
    GRAPHITE_TOPOLOGY_TODO.test(todo),
  )
  return topologyTodos.length === 1
}
