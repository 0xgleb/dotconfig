export interface AgentTokenUsage {
  readonly input: number
  readonly output: number
  readonly cacheRead: number
  readonly cacheWrite: number
  readonly totalTokens: number
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const tokenCount = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined

const messageUsage = (entry: unknown): AgentTokenUsage | undefined => {
  if (
    !isRecord(entry) ||
    entry.type !== "message" ||
    !isRecord(entry.message) ||
    (entry.message.role !== "assistant" &&
      entry.message.role !== "toolResult") ||
    !isRecord(entry.message.usage)
  ) {
    return undefined
  }
  const input = tokenCount(entry.message.usage.input)
  const output = tokenCount(entry.message.usage.output)
  const cacheRead = tokenCount(entry.message.usage.cacheRead)
  const cacheWrite = tokenCount(entry.message.usage.cacheWrite)
  const totalTokens = tokenCount(entry.message.usage.totalTokens)
  return input === undefined ||
    output === undefined ||
    cacheRead === undefined ||
    cacheWrite === undefined ||
    totalTokens === undefined
    ? undefined
    : { input, output, cacheRead, cacheWrite, totalTokens }
}

export const sessionTokenUsage: (
  entries: readonly unknown[],
) => AgentTokenUsage = entries =>
  entries.reduce<AgentTokenUsage>(
    (total, entry) => {
      const usage = messageUsage(entry)
      if (!usage) return total
      const next = {
        input: total.input + usage.input,
        output: total.output + usage.output,
        cacheRead: total.cacheRead + usage.cacheRead,
        cacheWrite: total.cacheWrite + usage.cacheWrite,
        totalTokens: total.totalTokens + usage.totalTokens,
      }
      return Object.values(next).every(Number.isSafeInteger) ? next : total
    },
    {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
    },
  )
