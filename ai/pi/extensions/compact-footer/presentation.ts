import { visibleWidth } from "@earendil-works/pi-tui"
import { alignChromeLine, chromeInset } from "../shared/chrome.ts"

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

export function formatFooter(
  input: FooterPresentation,
  width?: number,
): string {
  const location = input.branch ? `${input.cwd} (${input.branch})` : input.cwd
  const contextPercent =
    input.contextPercent === undefined
      ? "?"
      : `${input.contextPercent.toFixed(1)}%`
  const context = `ctx ${contextPercent} of ${formatTokens(input.contextWindow)}`
  const model = input.thinkingLevel
    ? `${input.modelId} / ${input.thinkingLevel}`
    : input.modelId

  const separator = " · "
  if (width === undefined) return [location, context, model].join(separator)
  const available = Math.max(0, width - 2 * chromeInset(width))
  const metricWidth = visibleWidth(context) + visibleWidth(model)
  const locationBudget = available - metricWidth - 2 * separator.length
  const branch = input.branch ? ` (${input.branch})` : ""
  const leaf = input.cwd.split("/").at(-1)
  const candidate = leaf ? `.../${leaf}${branch}` : location
  const fittedLocation =
    visibleWidth(location) > locationBudget &&
    visibleWidth(candidate) < visibleWidth(location)
      ? candidate
      : location
  const slack = locationBudget - visibleWidth(fittedLocation)
  if (slack < 0) {
    const compactContext = `${contextPercent}/${formatTokens(input.contextWindow)}`
    const compactModel = input.thinkingLevel
      ? `${input.modelId}/${input.thinkingLevel}`
      : model
    let line = ""
    for (const group of [fittedLocation, compactContext, compactModel]) {
      const next = line ? `${line}${separator}${group}` : group
      if (visibleWidth(next) <= available) line = next
    }
    return alignFooterLine(line, width)
  }
  const firstGap = Math.floor(slack / 2)
  const secondGap = slack - firstGap

  const gap = (extra: number): string =>
    " ".repeat(Math.floor(extra / 2)) +
    separator +
    " ".repeat(Math.ceil(extra / 2))
  return alignFooterLine(
    fittedLocation + gap(firstGap) + context + gap(secondGap) + model,
    width,
  )
}
