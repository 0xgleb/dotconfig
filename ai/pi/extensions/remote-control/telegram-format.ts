const escapeTelegramHtml = (text: string): string =>
  text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

const INLINE_MARKUP =
  /`([^`\n]+)`|\*\*([^*\n]+)\*\*|\[([^\]\n]+)\]\((https?:\/\/[^\s)<>"']+)\)/gu;

const renderInlineMarkdown = (line: string): string => {
  let rendered = "";
  let offset = 0;
  for (const match of line.matchAll(INLINE_MARKUP)) {
    const index = match.index;
    rendered += escapeTelegramHtml(line.slice(offset, index));
    if (match[1] !== undefined) {
      rendered += `<code>${escapeTelegramHtml(match[1])}</code>`;
    } else if (match[2] !== undefined) {
      rendered += `<b>${escapeTelegramHtml(match[2])}</b>`;
    } else if (match[3] !== undefined && match[4] !== undefined) {
      rendered += `<a href="${escapeTelegramHtml(match[4])}">${escapeTelegramHtml(match[3])}</a>`;
    }
    offset = index + match[0].length;
  }
  return rendered + escapeTelegramHtml(line.slice(offset));
};

const splitEscapedPlainText = (text: string, maximum: number): string[] => {
  const chunks: string[] = [];
  let chunk = "";
  for (const character of text) {
    const escaped = escapeTelegramHtml(character);
    if (chunk && chunk.length + escaped.length > maximum) {
      chunks.push(chunk);
      chunk = "";
    }
    chunk += escaped.slice(0, maximum);
  }
  if (chunk || chunks.length === 0) chunks.push(chunk);
  return chunks;
};

export const telegramHtmlChunks = (
  markdown: string,
  maximum = 4_000,
): readonly string[] => {
  const boundedMaximum = Math.max(32, maximum);
  const lines = markdown.split("\n").flatMap((line) => {
    const rendered = renderInlineMarkdown(line);
    return rendered.length <= boundedMaximum
      ? [rendered]
      : splitEscapedPlainText(line, boundedMaximum);
  });

  const chunks: string[] = [];
  let current = "";
  for (const line of lines) {
    const candidate = current ? `${current}\n${line}` : line;
    if (current && candidate.length > boundedMaximum) {
      chunks.push(current);
      current = line;
    } else {
      current = candidate;
    }
  }
  if (current || chunks.length === 0) chunks.push(current);
  return chunks;
};
