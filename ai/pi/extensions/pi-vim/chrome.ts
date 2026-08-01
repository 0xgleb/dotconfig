import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui"

export const PROMPT_MIN_CONTENT_ROWS = 3

const fillToWidth = (prefix: string, suffix: string, width: number): string => {
  const available = Math.max(
    0,
    width - visibleWidth(prefix) - visibleWidth(suffix),
  )
  return `${prefix}${"─".repeat(available)}${suffix}`
}

export const promptChromeInset = (width: number): number =>
  Math.min(1, Math.max(0, Math.floor((width - 4) / 2)))

export const promptChromeTopLine = (width: number): string => {
  const prefix = truncateToWidth("╭─ PROMPT ", Math.max(0, width), "")
  return fillToWidth(prefix, "─╮", width)
}

export const promptChromeBottomLine = (
  width: number,
  label: string,
): string => {
  const suffix = truncateToWidth(` ${label} ─╯`, Math.max(0, width), "")
  return fillToWidth("╰─", suffix, width)
}
