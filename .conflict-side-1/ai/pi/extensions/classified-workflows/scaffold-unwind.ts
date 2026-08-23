import { isAbsolute, resolve } from "node:path"

interface Replacement {
  readonly oldText: string
  readonly newText: string
}

interface EditInput {
  readonly path: string
  readonly edits: readonly Replacement[]
}

interface ToolCall {
  readonly name: string
  readonly input: unknown
  readonly index: number
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null

const editInput = (value: unknown): EditInput | undefined => {
  if (
    !isRecord(value) ||
    typeof value.path !== "string" ||
    !Array.isArray(value.edits)
  )
    return undefined
  const edits = value.edits.flatMap(entry =>
    isRecord(entry) &&
    typeof entry.oldText === "string" &&
    typeof entry.newText === "string"
      ? [{ oldText: entry.oldText, newText: entry.newText }]
      : [],
  )
  return edits.length === value.edits.length && edits.length > 0
    ? { path: value.path, edits }
    : undefined
}

const targetPath = (cwd: string, value: unknown): string | undefined => {
  if (!isRecord(value) || typeof value.path !== "string") return undefined
  return resolve(isAbsolute(value.path) ? value.path : resolve(cwd, value.path))
}

const messageText = (message: Readonly<Record<string, unknown>>): string => {
  if (typeof message.content === "string") return message.content
  if (!Array.isArray(message.content)) return ""
  return message.content
    .flatMap(part =>
      isRecord(part) && part.type === "text" && typeof part.text === "string"
        ? [part.text]
        : [],
    )
    .join("\n")
}

const weakeningOnlyReason = (reason: string): boolean => {
  const weakening =
    /(?:TTDD|test|verification|spec).*(?:weaken|remov|delet)|(?:weaken|remov|delet).*(?:TTDD|test|verification|spec)/i
  const independent =
    /\b(?:unauthori[sz]ed|unrelated|out of scope|committed|pre-existing|existing user|user-owned|protected|secret|credential|publish|deploy)\b/i
  return weakening.test(reason) && !independent.test(reason)
}

const reprioritization =
  /\b(?:reprioriti[sz](?:e|ed|ing)|defer(?:red|ring)?|postpone(?:d)?|new priority|higher priority|hotfix|instead|focus(?: now)? on|before)\b/i

const isSpecDocument = (path: string): boolean =>
  /\.(?:md|mdx|rst|adoc)$/i.test(path)

const isBlockedImplementationPrerequisite = (
  call: ToolCall,
  result: Readonly<Record<string, unknown>>,
  cwd: string,
  scaffoldTarget: string,
): boolean => {
  const blockedTarget = targetPath(cwd, call.input)
  if (
    !blockedTarget ||
    blockedTarget === scaffoldTarget ||
    isSpecDocument(blockedTarget)
  )
    return false
  const text = messageText(result)
  return (
    /^Auto-classifier verdict:/i.test(text.trim()) &&
    /\b(?:implementation|source|production code|code change)\b/i.test(text) &&
    /\b(?:e2e|test|TTDD|test-first)\b/i.test(text) &&
    /\b(?:before|first|missing|require[ds]?)\b/i.test(text)
  )
}

const exactInverse = (proposed: EditInput, prior: ToolCall): boolean => {
  const priorEdit = editInput(prior.input)
  if (prior.name === "edit" && priorEdit) {
    return proposed.edits.every(replacement =>
      priorEdit.edits.some(
        earlier =>
          replacement.oldText === earlier.newText &&
          replacement.newText === earlier.oldText,
      ),
    )
  }
  if (
    prior.name !== "write" ||
    !isRecord(prior.input) ||
    typeof prior.input.content !== "string"
  )
    return false
  return (
    proposed.edits.length === 1 &&
    proposed.edits[0]?.oldText === prior.input.content &&
    proposed.edits[0]?.newText === ""
  )
}

/**
 * Allow only a session-proven inverse of the latest successful agent mutation
 * after a later human message explicitly switches or defers that lane. This
 * restores the pre-scaffold text; it cannot remove committed or pre-existing
 * tests merely because the classifier describes them as inconvenient.
 */
export const exactScaffoldUnwindDisprovesBlock = (input: {
  readonly reason: string
  readonly edit: unknown
  readonly branch: readonly unknown[]
  readonly cwd: string
}): boolean => {
  if (!weakeningOnlyReason(input.reason)) return false
  const proposed = editInput(input.edit)
  const target = targetPath(input.cwd, proposed)
  if (!proposed || !target) return false

  const calls = new Map<string, ToolCall>()
  const mutationOutcomes: Array<{
    call: ToolCall
    result: Readonly<Record<string, unknown>>
    resultIndex: number
    successful: boolean
  }> = []
  const successfulMutations: Array<ToolCall & { resultIndex: number }> = []

  input.branch.forEach((entry, index) => {
    if (
      !isRecord(entry) ||
      entry.type !== "message" ||
      !isRecord(entry.message)
    )
      return
    const message = entry.message
    if (message.role === "assistant" && Array.isArray(message.content)) {
      for (const part of message.content) {
        if (
          isRecord(part) &&
          part.type === "toolCall" &&
          typeof part.id === "string" &&
          typeof part.name === "string"
        )
          calls.set(part.id, { name: part.name, input: part.arguments, index })
      }
      return
    }
    if (
      message.role !== "toolResult" ||
      typeof message.toolCallId !== "string" ||
      typeof message.isError !== "boolean"
    )
      return
    const call = calls.get(message.toolCallId)
    if (!call || (call.name !== "edit" && call.name !== "write")) return
    const successful = message.isError === false
    mutationOutcomes.push({
      call,
      result: message,
      resultIndex: index,
      successful,
    })
    if (successful && targetPath(input.cwd, call.input) === target)
      successfulMutations.push({ ...call, resultIndex: index })
  })

  const latest = successfulMutations.at(-1)
  if (!latest || !exactInverse(proposed, latest)) return false

  const laterHumanReprioritized = input.branch
    .slice(latest.resultIndex + 1)
    .some(
      entry =>
        isRecord(entry) &&
        entry.type === "message" &&
        isRecord(entry.message) &&
        entry.message.role === "user" &&
        reprioritization.test(messageText(entry.message)),
    )
  if (laterHumanReprioritized) return true
  if (!isSpecDocument(target)) return false

  const laterMutations = mutationOutcomes.filter(
    ({ resultIndex }) => resultIndex > latest.resultIndex,
  )
  if (laterMutations.some(({ successful }) => successful)) return false
  return laterMutations.some(({ call, result }) =>
    isBlockedImplementationPrerequisite(call, result, input.cwd, target),
  )
}
