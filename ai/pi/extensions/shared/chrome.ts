import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui"

export const chromeInset = (width: number): number =>
  Math.min(1, Math.max(0, Math.floor((width - 6) / 2)))

export const alignChromeLine = (line: string, width: number): string => {
  const inset = chromeInset(width)
  const contentWidth = Math.max(0, width - inset * 2)
  const content = truncateToWidth(line, contentWidth, "…")
  const contentPadding = " ".repeat(
    Math.max(0, contentWidth - visibleWidth(content)),
  )
  return `${" ".repeat(inset)}${content}${contentPadding}${" ".repeat(inset)}`
}
