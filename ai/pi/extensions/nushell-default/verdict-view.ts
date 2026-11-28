import { getMarkdownTheme } from "@earendil-works/pi-coding-agent"
import { Markdown } from "@earendil-works/pi-tui"

export const verdictView = (icon: string, explanation: string) => {
  const body = new Markdown(explanation, 1, 0, getMarkdownTheme())
  return {
    render: (width: number) => [icon, ...body.render(width)],
    invalidate: () => body.invalidate(),
  }
}
