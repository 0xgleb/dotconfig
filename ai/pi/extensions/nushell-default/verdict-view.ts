import { getMarkdownTheme } from "@earendil-works/pi-coding-agent"
import { Markdown } from "@earendil-works/pi-tui"

export const verdictView = (icon: string, explanation: string) => {
  const body = new Markdown(explanation, 1, 0, getMarkdownTheme())
  return {
    render: (width: number) => {
      if (width < 4) return [icon, ...body.render(width)]
      return body
        .render(width - 2)
        .map((row, index) => `${index === 0 ? `${icon} ` : "  "}${row}`)
    },
    invalidate: () => body.invalidate(),
  }
}
