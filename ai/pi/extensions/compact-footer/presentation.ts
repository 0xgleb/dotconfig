import { alignChromeLine } from "../shared/chrome.ts"

export interface FooterPresentation {
  readonly cwd: string
  readonly branch?: string
  readonly modelId: string
  readonly thinkingLevel?: string
  readonly contextPercent?: number
  readonly contextWindow: number
}

function formatTokens(count: number): string {
  if (count < 1_000) return `${count}`
  if (count < 10_000) return `${(count / 1_000).toFixed(1)}k`
  if (count < 1_000_000) return `${Math.round(count / 1_000)}k`
  if (count < 10_000_000) return `${(count / 1_000_000).toFixed(1)}M`
  return `${Math.round(count / 1_000_000)}M`
}

export const alignFooterLine = (footer: string, width: number): string =>
  alignChromeLine(footer, width)

export function formatFooter(input: FooterPresentation): string {
  const location = input.branch ? `${input.cwd} (${input.branch})` : input.cwd
  const contextPercent =
    input.contextPercent === undefined
      ? "?"
      : `${input.contextPercent.toFixed(1)}%`
  const groups = [
    location,
    `ctx ${contextPercent} of ${formatTokens(input.contextWindow)}`,
    input.thinkingLevel
      ? `${input.modelId} / ${input.thinkingLevel}`
      : input.modelId,
  ]

  return groups.join("  ·  ")
}
