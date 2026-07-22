export interface FooterPresentation {
  readonly cwd: string;
  readonly branch?: string;
  readonly modelId: string;
  readonly thinkingLevel?: string;
  readonly contextPercent?: number;
  readonly contextWindow: number;
  readonly cacheHitRate?: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly statuses: ReadonlyArray<string>;
}

function formatTokens(count: number): string {
  if (count < 1_000) return `${count}`;
  if (count < 10_000) return `${(count / 1_000).toFixed(1)}k`;
  if (count < 1_000_000) return `${Math.round(count / 1_000)}k`;
  if (count < 10_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  return `${Math.round(count / 1_000_000)}M`;
}

function sanitizeStatus(status: string): string {
  return status.replace(/[\r\n\t]/g, " ").replace(/ +/g, " ").trim();
}

export function formatFooter(input: FooterPresentation): string {
  const location = input.branch ? `${input.cwd} (${input.branch})` : input.cwd;
  const contextPercent = input.contextPercent === undefined ? "?" : `${input.contextPercent.toFixed(1)}%`;
  const groups = [
    location,
    `ctx ${contextPercent} of ${formatTokens(input.contextWindow)}`,
    input.cacheHitRate === undefined ? undefined : `cache ${input.cacheHitRate.toFixed(1)}%`,
    input.inputTokens || input.outputTokens
      ? `↑${formatTokens(input.inputTokens)} ↓${formatTokens(input.outputTokens)}`
      : undefined,
    input.thinkingLevel ? `${input.modelId} / ${input.thinkingLevel}` : input.modelId,
    ...input.statuses.map(sanitizeStatus).filter(Boolean),
  ].filter((group): group is string => group !== undefined);

  return groups.join("  ·  ");
}
