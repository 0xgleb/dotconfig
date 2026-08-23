const escapeTelegramHtml = (text: string): string =>
  text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")

const INLINE_MARKUP =
  /`([^`\n]+)`|\*\*([^*\n]+)\*\*|\[([^\]\n]+)\]\((https?:\/\/[^\s)<>"']+)\)/gu
const FENCE_START = /^```([A-Za-z0-9_+.-]*)[ \t]*$/u
const FENCE_END = /^```[ \t]*$/u

const renderInlineMarkdown = (line: string): string => {
  let rendered = ""
  let offset = 0
  for (const match of line.matchAll(INLINE_MARKUP)) {
    const index = match.index
    rendered += escapeTelegramHtml(line.slice(offset, index))
    if (match[1] !== undefined) {
      rendered += `<code>${escapeTelegramHtml(match[1])}</code>`
    } else if (match[2] !== undefined) {
      rendered += `<b>${escapeTelegramHtml(match[2])}</b>`
    } else if (match[3] !== undefined && match[4] !== undefined) {
      rendered += `<a href="${escapeTelegramHtml(match[4])}">${escapeTelegramHtml(match[3])}</a>`
    }
    offset = index + match[0].length
  }
  return rendered + escapeTelegramHtml(line.slice(offset))
}

const splitEscapedPlainText = (text: string, maximum: number): string[] => {
  const chunks: string[] = []
  let chunk = ""
  for (const character of text) {
    const escaped = escapeTelegramHtml(character)
    if (chunk && chunk.length + escaped.length > maximum) {
      chunks.push(chunk)
      chunk = ""
    }
    chunk += escaped.slice(0, maximum)
  }
  if (chunk || chunks.length === 0) chunks.push(chunk)
  return chunks
}

const codeWrapper = (
  language: string,
  maximum: number,
): { readonly opening: string; readonly closing: string } => {
  const safeLanguage = /^[A-Za-z0-9_+-]{1,32}$/u.test(language) ? language : ""
  const withLanguage = safeLanguage
    ? `<pre><code class="language-${safeLanguage}">`
    : "<pre><code>"
  const closing = "</code></pre>"
  return withLanguage.length + closing.length < maximum
    ? { opening: withLanguage, closing }
    : { opening: "<pre><code>", closing }
}

const renderCodeBlock = (
  code: string,
  language: string,
  maximum: number,
): readonly string[] => {
  const { opening, closing } = codeWrapper(language, maximum)
  const contentMaximum = Math.max(1, maximum - opening.length - closing.length)
  return splitEscapedPlainText(code, contentMaximum).map(
    content => `${opening}${content}${closing}`,
  )
}

const renderMarkdownUnits = (
  markdown: string,
  maximum: number,
): readonly string[] => {
  const lines = markdown.split("\n")
  const units: string[] = []
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? ""
    const fence = line.match(FENCE_START)
    if (fence) {
      const closingIndex = lines.findIndex(
        (candidate, candidateIndex) =>
          candidateIndex > index && FENCE_END.test(candidate),
      )
      if (closingIndex > index) {
        units.push(
          ...renderCodeBlock(
            lines.slice(index + 1, closingIndex).join("\n"),
            fence[1] ?? "",
            maximum,
          ),
        )
        index = closingIndex
        continue
      }
    }

    const rendered = renderInlineMarkdown(line)
    units.push(
      ...(rendered.length <= maximum
        ? [rendered]
        : splitEscapedPlainText(line, maximum)),
    )
  }
  return units
}

export const telegramHtmlChunks = (
  markdown: string,
  maximum = 4_000,
): readonly string[] => {
  const boundedMaximum = Math.max(32, maximum)
  const units = renderMarkdownUnits(markdown, boundedMaximum)
  const chunks: string[] = []
  let current = ""
  for (const unit of units) {
    const candidate = current ? `${current}\n${unit}` : unit
    if (current && candidate.length > boundedMaximum) {
      chunks.push(current)
      current = unit
    } else {
      current = candidate
    }
  }
  if (current || chunks.length === 0) chunks.push(current)
  return chunks
}
