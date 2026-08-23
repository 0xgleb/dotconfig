import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { registerRuntimeVersion } from "../shared/runtime-version.ts"

const GRAPHITE_MARKDOWN_LINK =
  /\[[^\]\n]*\]\((https:\/\/app\.graphite\.dev\/[^\s)]+)\)/g

const exposeGraphiteLinksOnLine = (line: string): string => {
  const segments = line.split(/(`[^`\n]*`)/g)
  return segments
    .map((segment, index) =>
      index % 2 === 0 ? segment.replace(GRAPHITE_MARKDOWN_LINK, "$1") : segment,
    )
    .join("")
}

export const exposeGraphiteUrls = (text: string): string => {
  let fenced = false
  return text
    .split("\n")
    .map(line => {
      if (/^\s*(`{3,}|~{3,})/.test(line)) {
        fenced = !fenced
        return line
      }
      return fenced ? line : exposeGraphiteLinksOnLine(line)
    })
    .join("\n")
}

const linkSafety = (pi: ExtensionAPI): void => {
  registerRuntimeVersion(pi, "link-safety", "2026.07.23.1")

  pi.on("message_end", event => {
    if (
      event.message.role !== "assistant" ||
      !Array.isArray(event.message.content)
    )
      return
    let changed = false
    const content = event.message.content.map(part => {
      if (part.type !== "text") return part
      const text = exposeGraphiteUrls(part.text)
      if (text === part.text) return part
      changed = true
      return { ...part, text }
    })
    return changed ? { message: { ...event.message, content } } : undefined
  })
}

export default linkSafety
