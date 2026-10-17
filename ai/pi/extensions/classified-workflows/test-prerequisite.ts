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

const isTestPath = (path: string): boolean =>
  /(?:^|\/)(?:tests?|__tests__)(?:\/|$)|(?:\.test|\.spec)\.[^/]+$|_test\.[^/]+$/i.test(
    path,
  )

const missingTestOnlyReason = (reason: string): boolean => {
  const missingTest =
    /(?:\b(?:missing|need(?:s|ed)?|require[ds]?)\b.*\b(?:test|e2e|TTDD)\b)|(?:\b(?:test|e2e|TTDD)\b.*\b(?:missing|required|before|first)\b)/i
  const independent =
    /\b(?:weaken|remov|delet|replace|unauthori[sz]ed|unrelated|out of scope|committed|pre-existing|user-owned|protected|secret|credential|publish|deploy)\b/i
  return missingTest.test(reason) && !independent.test(reason)
}

const DOMAIN_STOP_WORDS = new Set([
  "add",
  "adding",
  "assert",
  "component",
  "describe",
  "expect",
  "frontend",
  "regression",
  "spec",
  "test",
  "tests",
])

const domainTerms = (proposed: EditInput): readonly string[] =>
  [proposed.path, ...proposed.edits.map(({ newText }) => newText)]
    .join(" ")
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .filter(
      term =>
        term.length >= 3 &&
        !DOMAIN_STOP_WORDS.has(term) &&
        !/^tsx?|jsx?$/.test(term),
    )

const hasVerifiedPrerequisiteSet = (
  branch: readonly unknown[],
  proposed: EditInput,
): boolean => {
  const calls = new Map<string, ToolCall>()
  const terms = domainTerms(proposed)
  let committedBackendRegression = false
  let currentSpecContract = false
  let currentFrontendE2e = false
  for (const entry of branch) {
    if (
      !isRecord(entry) ||
      entry.type !== "message" ||
      !isRecord(entry.message)
    )
      continue
    const message = entry.message
    if (message.role === "assistant" && Array.isArray(message.content)) {
      for (const part of message.content) {
        if (
          isRecord(part) &&
          part.type === "toolCall" &&
          typeof part.id === "string" &&
          typeof part.name === "string"
        )
          calls.set(part.id, { name: part.name, input: part.arguments })
      }
      continue
    }
    if (
      message.role !== "toolResult" ||
      message.isError !== false ||
      typeof message.toolCallId !== "string"
    )
      continue
    const call = calls.get(message.toolCallId)
    if (!call || !isRecord(call.input)) continue
    const output = messageText(message).toLowerCase()
    const sharesDomain = terms.some(term => output.includes(term))
    if (!sharesDomain) continue

    if (call.name === "bash" && typeof call.input.command === "string") {
      const command = call.input.command.trim()
      if (
        /^git\s+show\s+[0-9a-f]{7,64}\b/.test(command) &&
        /(?:^|\/)tests?(?:\/|\b)|(?:\.test|\.spec)\./i.test(command) &&
        /\b(?:fn|test|it|describe)\b/.test(output)
      )
        committedBackendRegression = true
      continue
    }
    if (call.name !== "read" || typeof call.input.path !== "string") continue
    const path = call.input.path
    if (/(?:^|\/)SPEC\.md$/i.test(path)) currentSpecContract = true
    if (
      /(?:^|\/)(?:e2e|playwright)(?:\/|$)/i.test(path) &&
      /(?:\.test|\.spec)\.[^/]+$/i.test(path)
    )
      currentFrontendE2e = true
  }
  return committedBackendRegression && currentSpecContract && currentFrontendE2e
}

/**
 * Correct only a stale demand for another prerequisite test when the proposed
 * edit is strictly additive test code and current successful evidence proves
 * the same-domain committed backend regression, SPEC contract, and frontend
 * e2e. Implementation and replacement or weakening remain fail-closed.
 */
export const additiveTestEditDisprovesMissingTestBlock = (input: {
  readonly reason: string
  readonly edit: unknown
  readonly branch: readonly unknown[]
}): boolean => {
  if (!missingTestOnlyReason(input.reason)) return false
  const proposed = editInput(input.edit)
  if (!proposed || !isTestPath(proposed.path)) return false
  if (
    !proposed.edits.every(
      ({ oldText, newText }) =>
        newText.length > oldText.length && newText.includes(oldText),
    )
  )
    return false
  return hasVerifiedPrerequisiteSet(input.branch, proposed)
}
