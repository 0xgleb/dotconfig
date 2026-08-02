interface ToolCall {
  readonly name: string
  readonly input: unknown
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null

const messageText = (message: Readonly<Record<string, unknown>>): string => {
  if (typeof message.content === "string") return message.content
  if (!Array.isArray(message.content)) return ""
  return message.content
    .flatMap((part) =>
      isRecord(part) &&
      part.type === "text" &&
      typeof part.text === "string"
        ? [part.text]
        : [],
    )
    .join("\n")
}

const recoveryOnlyReason = (reason: string): boolean => {
  const recovery =
    /\b(?:previously executed|already executed)\b.*\b(?:withheld|filtered)\b.*\b(?:independent|verify|verification)\b|\b(?:independent|verify|verification)\b.*\b(?:withheld|filtered)\b/i
  const independent =
    /\b(?:unauthori[sz]ed|unrelated|out of scope|secret|credential|protected|destructive|publish|deploy|mutation)\b/i
  return recovery.test(reason) && !independent.test(reason)
}

const exactPrSearch = (
  value: unknown,
): { readonly command: string; readonly owner: string } | undefined => {
  if (!isRecord(value) || typeof value.command !== "string") return undefined
  const command = value.command.trim()
  if (/[;&|`\n]/.test(command) || !/^gh\s+search\s+prs\b/.test(command))
    return undefined
  const owner = command.match(/--owner(?:=|\s+)([A-Za-z0-9_.-]+)/)?.[1]
  if (
    !owner ||
    !/--author(?:=|\s+)@me\b/.test(command) ||
    !/--state(?:=|\s+)open\b/.test(command)
  )
    return undefined
  return { command, owner: owner.toLowerCase() }
}

const matchingIndependentApiRead = (
  command: string,
  owner: string,
): boolean => {
  if (/[;&|`\n]/.test(command) || !/^gh\s+api\b/.test(command)) return false
  if (!/(?:--method\s+GET|-X\s+GET)\b/i.test(command)) return false
  if (!/\bsearch\/issues\b/.test(command)) return false
  const lower = command.toLowerCase()
  return (
    lower.includes("is:pr") &&
    lower.includes("is:open") &&
    lower.includes("author:@me") &&
    (lower.includes(`org:${owner}`) || lower.includes(`user:${owner}`))
  )
}

/**
 * Recover one withheld read-only PR inventory only after a later successful
 * alternate GitHub API read proves the same owner/author/open-PR query. This
 * never applies to mutations or unrelated API results.
 */
export const independentPrInventoryDisprovesWithheldRetryBlock = (input: {
  readonly reason: string
  readonly bash: unknown
  readonly branch: readonly unknown[]
}): boolean => {
  if (!recoveryOnlyReason(input.reason)) return false
  const proposed = exactPrSearch(input.bash)
  if (!proposed) return false

  const calls = new Map<string, ToolCall>()
  let withheldIndex = -1
  let verifiedIndex = -1
  input.branch.forEach((entry, index) => {
    if (!isRecord(entry) || entry.type !== "message" || !isRecord(entry.message))
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
          calls.set(part.id, { name: part.name, input: part.arguments })
      }
      return
    }
    if (
      message.role !== "toolResult" ||
      typeof message.toolCallId !== "string"
    )
      return
    const call = calls.get(message.toolCallId)
    if (!call || call.name !== "bash" || !isRecord(call.input)) return
    if (typeof call.input.command !== "string") return
    const command = call.input.command.trim()
    const text = messageText(message)
    if (
      command === proposed.command &&
      /Result content was withheld by classified workflow policy/i.test(text)
    ) {
      withheldIndex = index
      return
    }
    if (
      message.isError === false &&
      matchingIndependentApiRead(command, proposed.owner)
    )
      verifiedIndex = index
  })

  return withheldIndex >= 0 && verifiedIndex > withheldIndex
}
