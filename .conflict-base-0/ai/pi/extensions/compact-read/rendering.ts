export type CodeHighlighter = (code: string, language?: string) => string[]
export type LanguageResolver = (path: string) => string | undefined

export interface CodeRenderingTheme {
  readonly fg: (color: "dim" | "toolDiffAdded" | "toolDiffRemoved" | "toolDiffContext", text: string) => string
  readonly bg: (color: "toolSuccessBg" | "toolErrorBg", text: string) => string
}

export const highlightFileContent = (
  path: string,
  content: string,
  resolveLanguage: LanguageResolver,
  highlighter: CodeHighlighter,
): string => highlighter(content, resolveLanguage(path)).join("\n")

const backgroundWithNestedStyles = (
  content: string,
  background: (text: string) => string,
): string => {
  const sentinel = "\u0000"
  const sample = background(sentinel)
  const sentinelIndex = sample.indexOf(sentinel)
  if (sentinelIndex === -1) return background(content)
  const prefix = sample.slice(0, sentinelIndex)
  const suffix = sample.slice(sentinelIndex + sentinel.length)
  const resetSafe = content.replace(/\x1b\[(?:0|49)m/g, reset => `${reset}${prefix}`)
  return `${prefix}${resetSafe}${suffix}`
}

const highlightedLine = (
  line: string,
  language: string | undefined,
  highlighter: CodeHighlighter,
): string => highlighter(line, language)[0] ?? ""

export const highlightUnifiedDiff = (
  path: string,
  diff: string,
  theme: CodeRenderingTheme,
  resolveLanguage: LanguageResolver,
  highlighter: CodeHighlighter,
): string => {
  const language = resolveLanguage(path)
  return diff
    .split("\n")
    .map(line => {
      if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("@@")) {
        return theme.fg("dim", line)
      }
      if (line.startsWith("+")) {
        const syntax = highlightedLine(line.slice(1), language, highlighter)
        const rendered = `${theme.fg("toolDiffAdded", "+")}${syntax}`
        return backgroundWithNestedStyles(rendered, text => theme.bg("toolSuccessBg", text))
      }
      if (line.startsWith("-")) {
        const syntax = highlightedLine(line.slice(1), language, highlighter)
        const rendered = `${theme.fg("toolDiffRemoved", "-")}${syntax}`
        return backgroundWithNestedStyles(rendered, text => theme.bg("toolErrorBg", text))
      }
      const context = line.startsWith(" ") ? line.slice(1) : line
      return `${theme.fg("toolDiffContext", line.startsWith(" ") ? " " : "")}${highlightedLine(context, language, highlighter)}`
    })
    .join("\n")
}
