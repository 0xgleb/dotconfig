import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent"
import {
  matchesKey,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui"

const padded = (text: string, width: number): string => {
  const clipped = truncateToWidth(text, width, "…", true)
  return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)))
}

export class ManagerAnswerPanel {
  private scroll = 0
  private readonly question: string
  private readonly answer: string
  private readonly model: string
  private readonly theme: Theme
  private readonly close: (continueChat: boolean) => void
  private readonly requestRender: () => void
  private readonly label: string

  constructor(
    question: string,
    answer: string,
    model: string,
    theme: Theme,
    close: (continueChat: boolean) => void,
    requestRender: () => void,
    label = "/manager",
  ) {
    this.question = question
    this.answer = answer
    this.model = model
    this.theme = theme
    this.close = close
    this.requestRender = requestRender
    this.label = label
  }

  handleInput(data: string): void {
    if (matchesKey(data, "escape") || matchesKey(data, "enter")) {
      this.close(matchesKey(data, "enter"))
      return
    }
    if (matchesKey(data, "up")) this.scroll = Math.max(0, this.scroll - 1)
    if (matchesKey(data, "down")) this.scroll += 1
    if (matchesKey(data, "pageup")) this.scroll = Math.max(0, this.scroll - 8)
    if (matchesKey(data, "pagedown")) this.scroll += 8
    if (matchesKey(data, "home")) this.scroll = 0
    if (matchesKey(data, "end")) this.scroll = Number.MAX_SAFE_INTEGER
    this.requestRender()
  }

  render(width: number): string[] {
    const innerWidth = Math.max(20, width - 2)
    const contentWidth = Math.max(16, innerWidth - 2)
    const border = (text: string) => this.theme.fg("border", text)
    const row = (text = "") =>
      `${border("│")}${padded(` ${text}`, innerWidth)}${border("│")}`
    const questionLines = wrapTextWithAnsi(this.question, contentWidth).slice(
      0,
      4,
    )
    const answerLines = this.answer
      .replace(/\r\n?/g, "\n")
      .split("\n")
      .flatMap(line => wrapTextWithAnsi(line || " ", contentWidth))
    const visibleLines = 20
    const maxScroll = Math.max(0, answerLines.length - visibleLines)
    this.scroll = Math.min(Math.max(0, this.scroll), maxScroll)
    const shown = answerLines.slice(this.scroll, this.scroll + visibleLines)
    const scrollLabel =
      answerLines.length > visibleLines
        ? ` · lines ${this.scroll + 1}-${Math.min(answerLines.length, this.scroll + visibleLines)} of ${answerLines.length}`
        : ""
    return [
      `${border("╭─")} ${this.theme.fg("accent", this.theme.bold(this.label))} ${border("─".repeat(Math.max(0, innerWidth - visibleWidth(this.label) - 3)) + "╮")}`,
      row(this.theme.fg("dim", `${this.model}${scrollLabel}`)),
      row(this.theme.fg("warning", "Q") + ` ${questionLines[0] ?? ""}`),
      ...questionLines.slice(1).map(line => row(`  ${line}`)),
      row(),
      ...shown.map(line => row(line)),
      row(),
      row(this.theme.fg("dim", "↑↓/Pg scroll · Enter continue · Esc close")),
      `${border("╰" + "─".repeat(innerWidth) + "╯")}`,
    ].map(line => truncateToWidth(line, width, "", true))
  }
  invalidate(): void {}
}

// Kept as a loadable module for existing extension-path configurations.
const panelExtension = (_pi: ExtensionAPI): void => {}
export default panelExtension
