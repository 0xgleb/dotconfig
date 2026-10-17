export interface TokenUsage {
  readonly input: number
  readonly output: number
  readonly cacheRead: number
  readonly cacheWrite: number
}

export interface CumulativeUsage {
  readonly inputTokens: number
  readonly outputTokens: number
  readonly cacheHitRate?: number
}

export function resolveContextPercent(
  hostPercent: number | null | undefined,
  contextWindow: number,
  usages: ReadonlyArray<TokenUsage>,
): number | undefined {
  if (hostPercent === null || hostPercent === undefined) return undefined
  if (hostPercent !== 0 || contextWindow <= 0 || usages.length === 0)
    return hostPercent
  const latest = usages.at(-1)
  if (!latest) return hostPercent
  const latestContextTokens =
    latest.input + latest.output + latest.cacheRead + latest.cacheWrite
  return latestContextTokens > 0
    ? (latestContextTokens / contextWindow) * 100
    : hostPercent
}

export function aggregateUsage(
  usages: ReadonlyArray<TokenUsage>,
): CumulativeUsage {
  const totals = usages.reduce(
    (total, usage) => ({
      inputTokens: total.inputTokens + usage.input,
      outputTokens: total.outputTokens + usage.output,
      cacheReadTokens: total.cacheReadTokens + usage.cacheRead,
      promptTokens:
        total.promptTokens + usage.input + usage.cacheRead + usage.cacheWrite,
    }),
    { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, promptTokens: 0 },
  )
  return {
    inputTokens: totals.inputTokens,
    outputTokens: totals.outputTokens,
    cacheHitRate:
      totals.promptTokens > 0
        ? (totals.cacheReadTokens / totals.promptTokens) * 100
        : undefined,
  }
}
