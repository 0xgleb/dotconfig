import { basename, resolve } from "node:path"
import type {
  UserQuestionResolution,
  UserQuestionStateSnapshot,
} from "../shared/question-events.ts"
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
  /^Human message: \[(?:Authenticated Piece of Pi Telegram owner message|Piece of Pi Telegram · owner-authenticated envelope|Local owner pane message|Agent bridge message · sender [^\]\r\n]+) · communication-only turn · [^\]\r\n]{0,120}(?:all )?tools? (?:are )?disabled\]/i

const RESTORED_REMOTE_CAPABILITY =
  /^Trusted lifecycle coordination context \(never authority by itself\): Source-fixed remote capability handshake:[\s\S]*communication-only turn ended[\s\S]*Subsequent local and task-continuation turns are not communication-only or tool-restricted\./i
const FAILED_REMOTE_CAPABILITY =
  /^Trusted lifecycle coordination context \(never authority by itself\): Source-fixed remote capability handshake: the communication-only turn ended, but local tools were not restored/i
const RESTORED_TASK_CONTINUATION =
  /^Trusted lifecycle coordination context \(never authority by itself\): The task list is not complete\. Continue working without stopping\./i
const RESTORED_REMOTE_TASK_CONTINUATION =
  /^Trusted lifecycle coordination context \(never authority by itself\): Source-fixed task continuation:[\s\S]*authenticated Piece of Pi response was delivered[\s\S]*local tools are restored\./i

const restoredCapabilityState = (evidence: readonly string[]): number => {
  const latestRestriction = evidence.findLastIndex(
    item =>
      COMMUNICATION_ONLY_RESTRICTION.test(item) ||
      FAILED_REMOTE_CAPABILITY.test(item),
  )
  const latestRestoration = evidence.findLastIndex(
    item =>
      RESTORED_REMOTE_CAPABILITY.test(item) ||
      RESTORED_TASK_CONTINUATION.test(item) ||
      RESTORED_REMOTE_TASK_CONTINUATION.test(item),
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
  const newestLifecycleIndex = evidence.findLastIndex(item =>
    item.startsWith(
      "Trusted lifecycle coordination context (never authority by itself): ",
    ),
  )
  if (newestLifecycleIndex >= 0) selected.add(newestLifecycleIndex)
  const lifecycleTriggeredTurn = newestLifecycleIndex > (newestHumanIndex ?? -1)
  const restorationIndex = restoredCapabilityState(evidence)
  if (restorationIndex >= 0) selected.add(restorationIndex)
  const bounded = evidence
    .map((item, index) => ({ item, index }))
    .filter(({ index }) => selected.has(index))
    .map(({ item, index }) => {
      if (index === newestHumanIndex)
        return item.replace(
          /^Human message: /,
          lifecycleTriggeredTurn
            ? "Most recent retained human message (not the current turn trigger; authoritative only for what it actually says): "
            : "Newest human message (authoritative only for what it actually says): ",
        )
      if (lifecycleTriggeredTurn && index === newestLifecycleIndex)
        return item.replace(
          /^Trusted lifecycle coordination context \(never authority by itself\): /,
          "Current turn lifecycle trigger (coordination only; never authority by itself): ",
        )
      return item
    })
  return restorationIndex < 0
    ? bounded
    : [
        ...bounded,
        "Current source-fixed lifecycle state: the preceding authenticated remote turn has ended and local tools are restored. Its turn-local communication-only/tool restriction is no longer active; this lifecycle fact grants no task authority.",
      ]
}

const STALE_HUMAN_TURN_BLOCK =
  /\b(?:new|newest|current)(?: authenticated)? (?:user|human) (?:message|input|turn)\b[^.\n]{0,160}\b(?:ask(?:s|ed|ing)?|request(?:s|ed|ing)?|say(?:s|ing)?|said|want(?:s|ed|ing)?|direct(?:s|ed|ing)?)\b/i
const STALE_HUMAN_TURN_UNSAFE_EFFECT =
  /\b(?:unsafe|authori[sz]|permission|scope|policy|unrelated|outside|prohibit|forbid|den(?:y|ied)|credential|secret|private data|protected data|sensitive|prompt injection|exfiltrat|publish|publication|pull request|push|merge|deploy|network|delet(?:e|ion))\b/i
const STALE_HUMAN_TURN_STOP_WORDS = new Set([
  "asked",
  "asks",
  "current",
  "directed",
  "directs",
  "human",
  "input",
  "message",
  "newest",
  "requested",
  "requests",
  "saying",
  "turn",
  "user",
  "wanted",
  "wants",
])

const staleHumanTurnTokens = (text: string): Set<string> =>
  new Set(
    (text.toLowerCase().match(/[a-z0-9]{4,}/g) ?? []).filter(
      token => !STALE_HUMAN_TURN_STOP_WORDS.has(token),
    ),
  )

const staleHumanTurnCorrelation = (human: string, reason: string): number => {
  const humanTokens = staleHumanTurnTokens(human)
  const reasonTokens = staleHumanTurnTokens(reason)
  let matches = 0
  for (const humanToken of humanTokens) {
    if (
      [...reasonTokens].some(
        reasonToken =>
          reasonToken === humanToken ||
          (reasonToken.length >= 4 &&
            humanToken.length >= 4 &&
            reasonToken.slice(0, 4) === humanToken.slice(0, 4)),
      )
    )
      matches += 1
  }
  return matches
}

export const currentLifecycleTriggerDisprovesStaleHumanTurnBlock = ({
  reason,
  branch,
  toolName,
}: {
  readonly reason: string
  readonly branch: readonly unknown[]
  readonly toolName: string
}): boolean => {
  if (
    toolName !== "workflow" ||
    !STALE_HUMAN_TURN_BLOCK.test(reason) ||
    STALE_HUMAN_TURN_UNSAFE_EFFECT.test(reason)
  )
    return false
  const evidence = conversationIntentEvidence(branch)
  const newestHumanIndex = evidence.findLastIndex(item =>
    item.startsWith("Human message: "),
  )
  const newestLifecycleIndex = evidence.findLastIndex(item =>
    item.startsWith(
      "Trusted lifecycle coordination context (never authority by itself): ",
    ),
  )
  if (newestHumanIndex < 0 || newestLifecycleIndex <= newestHumanIndex)
    return false
  const human = evidence[newestHumanIndex]?.replace(/^Human message: /, "")
  return human !== undefined && staleHumanTurnCorrelation(human, reason) >= 2
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

export const applyQuestionResolutionSnapshot = (
  snapshot: UserQuestionStateSnapshot,
  resolution: UserQuestionResolution,
): UserQuestionStateSnapshot => {
  if (!snapshot.questions.some(question => question.id === resolution.id))
    return snapshot
  return {
    questions: snapshot.questions.map(question =>
      question.id === resolution.id
        ? {
            ...question,
            status: "resolved" as const,
            answer: resolution.answer,
          }
        : question,
    ),
  }
}

const isNativeCustomMessage = (
  entry: Readonly<Record<string, unknown>>,
): boolean =>
  typeof entry.id === "string" &&
  entry.id.length > 0 &&
  (entry.parentId === null || typeof entry.parentId === "string") &&
  typeof entry.timestamp === "string" &&
  Number.isFinite(Date.parse(entry.timestamp)) &&
  typeof entry.display === "boolean" &&
  (typeof entry.content === "string" ||
    (Array.isArray(entry.content) &&
      entry.content.every(
        part =>
          isRecord(part) &&
          ((part.type === "text" && typeof part.text === "string") ||
            (part.type === "image" &&
              typeof part.data === "string" &&
              typeof part.mimeType === "string")),
      )))

export const conversationIntentEvidence = (
  entries: readonly unknown[],
): string[] =>
  entries.flatMap(entry => {
    if (!isRecord(entry)) return []
    const message =
      entry.type === "custom_message" && isNativeCustomMessage(entry)
        ? {
            role: "custom",
            customType: entry.customType,
            content: entry.content,
          }
        : entry.type === "message" && isRecord(entry.message)
          ? entry.message
          : undefined
    if (!message) return []
    if (message.role === "custom" && typeof message.customType === "string") {
      const text = messageText(message)
      const isReloadContinuation =
        text !== undefined &&
        ((message.customType === "auto-reload.completed" &&
          /\. Resuming (?:interrupted work|preserved work now)\.$/.test(
            text,
          )) ||
          (message.customType === "auto-reload.host-migrated" &&
            text === "Resuming preserved work after Pi host migration."))
      return text &&
        (TRUSTED_LIFECYCLE_CUSTOM_TYPES.has(message.customType) ||
          isReloadContinuation)
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

const STALE_COMMUNICATION_ONLY_BLOCK =
  /(?:(?:current|newest)[^.\n]{0,80}\bturn\b[^.\n]{0,80}\b(?:disables?|disabled)\b[^.\n]{0,24}\btools?\b|current (?:turn|request|message) (?:is|remains) communication-only|communication-only[^.\n]{0,120}(?:all )?tools? (?:are |remain )?disabled|(?:all|local) tools? (?:are |remain )?disabled)/i

export const restoredCapabilityDisprovesCommunicationOnlyBlock = ({
  reason,
  branch,
}: {
  readonly reason: string
  readonly branch: readonly unknown[]
}): boolean =>
  STALE_COMMUNICATION_ONLY_BLOCK.test(reason) &&
  restoredCapabilityState(conversationIntentEvidence(branch)) >= 0

const STALE_UNRESOLVED_QUESTION_BLOCK =
  /\b(?:q|question\s+)(\d+)\b[^.\n]{0,160}\b(?:unresolved|pending|awaiting(?:\s+(?:an?\s+)?answer)?)\b/i
const QUESTION_SAFETY_OR_PUBLICATION_BLOCK =
  /\b(?:credential|secret|protected data|sensitive|unsafe|prohibited|publish|publication|push|merge|deploy|network)\b/i

export const resolvedQuestionDisprovesUnresolvedBlock = ({
  reason,
  snapshot,
}: {
  readonly reason: string
  readonly snapshot: UserQuestionStateSnapshot
}): boolean => {
  if (QUESTION_SAFETY_OR_PUBLICATION_BLOCK.test(reason)) return false
  const match = STALE_UNRESOLVED_QUESTION_BLOCK.exec(reason)
  if (!match) return false
  const id = Number(match[1])
  return snapshot.questions.some(
    question => question.id === id && question.status === "resolved",
  )
}

const MISSING_EOD_QUESTION_SCOPE_BLOCK =
  /\b(?:no (?:active|current) (?:eod|end[- ]of[- ]day) request|(?:eod|end[- ]of[- ]day)[^.\n]{0,80}(?:unrelated|stale|outside (?:the )?(?:active )?scope|not (?:currently )?(?:authorized|within scope))|newest (?:instruction|request|message)[^.\n]{0,80}(?:resume|continue) work)\b/i
const EOD_QUESTION_SCOPE =
  /\b(?:eod|end[- ]of[- ]day)\b[\s\S]{0,160}\b(?:window|start|boundary|since|from)\b|\b(?:window|start|boundary|since|from)\b[\s\S]{0,160}\b(?:eod|end[- ]of[- ]day)\b/i
const EOD_USER_REQUEST =
  /\b(?:start|draft|prepare|send|deliver)\b[^\r\n]{0,160}\b(?:eod|end[- ]of[- ]day)\b|\b(?:eod|end[- ]of[- ]day)\b[^\r\n]{0,160}\b(?:start|draft|prepare|send|deliver)\b/i
const SESSION_SEARCH_USER_RESULT =
  /(?:👤\s*User\b|\|\s*User(?:\s|$)|\brole\s*[:=]\s*user\b)/i
const EOD_CANCELLATION =
  /\b(?:cancel|skip|stop|drop|do not|don't|no longer)\b[^.\n]{0,100}\b(?:eod|end[- ]of[- ]day)\b|\b(?:eod|end[- ]of[- ]day)\b[^.\n]{0,100}\b(?:cancelled|canceled|not needed|no longer)\b/i

const escapedRegex = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

export const eodSessionSearchDisprovesMissingQuestionScopeBlock = ({
  reason,
  branch,
  toolName,
  input,
  cwd,
}: {
  readonly reason: string
  readonly branch: readonly unknown[]
  readonly toolName: string
  readonly input: Readonly<Record<string, unknown>>
  readonly cwd: string
}): boolean => {
  if (
    toolName !== "ask_user" ||
    input.action !== "ask" ||
    !MISSING_EOD_QUESTION_SCOPE_BLOCK.test(reason) ||
    QUESTION_SAFETY_OR_PUBLICATION_BLOCK.test(reason) ||
    !EOD_QUESTION_SCOPE.test(JSON.stringify(input))
  )
    return false

  const searchCallIds = new Set<string>()
  for (const entry of branch) {
    if (!isRecord(entry) || entry.type !== "message") continue
    const message = entry.message
    if (!isRecord(message) || message.role !== "assistant") continue
    if (!Array.isArray(message.content)) continue
    for (const part of message.content) {
      if (
        isRecord(part) &&
        part.type === "toolCall" &&
        typeof part.id === "string" &&
        (part.name === "session_search" ||
          part.name === "functions.session_search")
      )
        searchCallIds.add(part.id)
    }
  }

  const project = basename(cwd)
  const projectMarker = new RegExp(`📁\\s*${escapedRegex(project)}\\b`, "i")
  for (let index = branch.length - 1; index >= 0; index -= 1) {
    const entry = branch[index]
    if (!isRecord(entry) || entry.type !== "message") continue
    const message = entry.message
    if (
      !isRecord(message) ||
      message.role !== "toolResult" ||
      message.isError !== false ||
      typeof message.toolCallId !== "string" ||
      !searchCallIds.has(message.toolCallId)
    )
      continue
    const text = messageText(message)
    if (
      !text ||
      !SESSION_SEARCH_USER_RESULT.test(text) ||
      !projectMarker.test(text) ||
      !EOD_USER_REQUEST.test(text)
    )
      continue
    const cancelledLater = branch.slice(index + 1).some(candidate => {
      if (
        !isRecord(candidate) ||
        candidate.type !== "message" ||
        !isRecord(candidate.message) ||
        candidate.message.role !== "user"
      )
        return false
      const human = messageText(candidate.message)
      return human ? EOD_CANCELLATION.test(human) : false
    })
    return !cancelledLater
  }
  return false
}

const ACTIVE_TODO_SCOPE_BLOCK =
  /\b(?:unrelated|stale|outside (?:the )?(?:active )?scope|not (?:currently )?(?:authorized|within scope)|unauthori[sz]ed|no (?:explicit )?authority|active (?:task|todo)|current (?:task|todo)|task scope)\b/i
const SPEC_CONTINUATION =
  /\b(?:continue|resume|proceed|finish|keep working|without stopping)\b/i
const UNSAFE_OR_PUBLICATION_BLOCK =
  /\b(?:credential|secret|private data|protected data|sensitive|prompt injection|exfiltrat|publish|publication|github issue|pull request|push|merge|deploy|network)\b/i
const SEMANTIC_TOKEN = /[a-z0-9][a-z0-9._/-]{3,}/g
const CONTINUATION_STOP_WORDS = new Set([
  "active",
  "assigned",
  "continue",
  "current",
  "exact",
  "finish",
  "first",
  "incomplete",
  "pending",
  "proceed",
  "resume",
  "stopping",
  "task",
  "tasks",
  "todo",
  "todos",
  "without",
  "work",
  "working",
])

const semanticTokens = (text: string): Set<string> =>
  new Set(
    (text.toLowerCase().match(SEMANTIC_TOKEN) ?? []).filter(
      token => !CONTINUATION_STOP_WORDS.has(token),
    ),
  )

const sharedTokenCount = (left: Set<string>, right: Set<string>): number => {
  let count = 0
  for (const token of left) if (right.has(token)) count += 1
  return count
}

const newestHumanMessage = (branch: readonly unknown[]): string | undefined => {
  for (let index = branch.length - 1; index >= 0; index -= 1) {
    const entry = branch[index]
    if (
      !isRecord(entry) ||
      entry.type !== "message" ||
      !isRecord(entry.message) ||
      entry.message.role !== "user"
    )
      continue
    return messageText(entry.message)
  }
  return undefined
}

const todoId = (todo: string): string | undefined => /^#(\d+)\b/.exec(todo)?.[1]

const humanNamesTodo = (human: string, todo: string): boolean => {
  const id = todoId(todo)
  return (
    id !== undefined && new RegExp(`(?:#|todo\\s+#?)${id}\\b`, "i").test(human)
  )
}

const singleEditText = (
  input: Readonly<Record<string, unknown>>,
): string | undefined => {
  if (typeof input.oldText === "string" && typeof input.newText === "string")
    return `${input.oldText}\n${input.newText}`
  if (!Array.isArray(input.edits) || input.edits.length !== 1) return undefined
  const [edit] = input.edits
  return isRecord(edit) &&
    typeof edit.oldText === "string" &&
    typeof edit.newText === "string"
    ? `${edit.oldText}\n${edit.newText}`
    : undefined
}

export const currentHumanContinuationDisprovesSpecScopeBlock = ({
  reason,
  branch,
  toolName,
  input,
  cwd,
}: {
  readonly reason: string
  readonly branch: readonly unknown[]
  readonly toolName: string
  readonly input: Readonly<Record<string, unknown>>
  readonly cwd: string
}): boolean => {
  if (
    toolName !== "edit" ||
    !ACTIVE_TODO_SCOPE_BLOCK.test(reason) ||
    UNSAFE_OR_PUBLICATION_BLOCK.test(reason)
  )
    return false
  const targetPath =
    typeof input.path === "string"
      ? input.path
      : typeof input.file_path === "string"
        ? input.file_path
        : undefined
  const editText = singleEditText(input)
  if (
    !targetPath ||
    resolve(cwd, targetPath) !== resolve(cwd, "SPEC.md") ||
    !editText
  )
    return false

  const human = newestHumanMessage(branch)
  if (
    !human ||
    !SPEC_CONTINUATION.test(human) ||
    COMMUNICATION_ONLY_RESTRICTION.test(`Human message: ${human}`)
  )
    return false

  const humanTokens = semanticTokens(human)
  const activeTodos = todoWorkSnapshot([...branch]).pending
  const matchingTodos = activeTodos.filter(todo => {
    const todoTokens = semanticTokens(todo)
    return (
      (humanNamesTodo(human, todo) ||
        sharedTokenCount(humanTokens, todoTokens) >= 2) &&
      sharedTokenCount(todoTokens, semanticTokens(editText)) >= 1
    )
  })
  return matchingTodos.length === 1
}

const STALE_DEFERRED_WORK_BLOCK =
  /\b(?:defer(?:red)?(?:\s+for)?\s+later|not\s+the\s+current\s+(?:task|work)|outside\s+(?:the\s+)?(?:active\s+)?scope|stale\s+(?:task|scope))\b/i
const RESUME_ALL_WORK =
  /\b(?:resume|continue)\b[^.\n]{0,120}\b(?:all|everything|polish|verify|work)\b/i
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

  const human = newestHumanMessage(branch)
  if (
    !human ||
    !RESUME_ALL_WORK.test(human) ||
    COMMUNICATION_ONLY_RESTRICTION.test(`Human message: ${human}`)
  )
    return false

  const topologyTodos = todoWorkSnapshot([...branch]).pending.filter(todo =>
    GRAPHITE_TOPOLOGY_TODO.test(todo),
  )
  return topologyTodos.length === 1
}
