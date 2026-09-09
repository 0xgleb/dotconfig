import type { ToolResultEvent } from "@earendil-works/pi-coding-agent"

type ToolResultContent = ToolResultEvent["content"]

interface ProtectedResultRequest {
  readonly toolName: string
  readonly input: Readonly<Record<string, unknown>>
  readonly content: ToolResultContent
}

interface ProtectedResult {
  readonly content: ToolResultContent
  readonly redacted: boolean
}

const GITBUTLER_DIFF_COMMAND =
  /(?:^|[\s;&|])(?:[^\s;&|]*\/)?\^?but(?:\s+-C\s+(?:"[^"]*"|'[^']*'|\S+))?\s+diff(?:\s|$)/

const PROTECTED_DIFF_PATH =
  /(^|[\\/\s'"])(?:\.env(?!\.example(?:$|[\\/\s'"]))(?:\.[^\\/\s'"]*)?|credentials(?:\.[^\\/\s'"]+)?|secrets\.[^\\/\s'"]+|(?:secrets|agenix|turnkey|1password)[\\/][^\s'"]*|keys\.nix|[^\\/\s'"]+\.(?:age|key|pem|p12|pfx))($|[\\/\s'"])/i

const DIFF_SECTION_HEADER = /^diff --(?:git|cc|combined)\b/
const FILE_SECTION_HEADER = /^(?:---|\+\+\+)\s+/
const REDACTION_MARKER = "[protected diff payload redacted]"

const redactProtectedDiffText = (
  text: string,
): { readonly text: string; readonly redacted: boolean } => {
  const output: string[] = []
  let redacting = false
  let redacted = false

  for (const line of text.split("\n")) {
    if (DIFF_SECTION_HEADER.test(line)) {
      redacting = PROTECTED_DIFF_PATH.test(line)
      output.push(line)
      if (redacting) {
        output.push(REDACTION_MARKER)
        redacted = true
      }
      continue
    }
    if (!redacting && FILE_SECTION_HEADER.test(line)) {
      redacting = PROTECTED_DIFF_PATH.test(line)
      output.push(line)
      if (redacting) {
        output.push(REDACTION_MARKER)
        redacted = true
      }
      continue
    }
    if (!redacting) output.push(line)
  }

  return { text: output.join("\n"), redacted }
}

/**
 * Trust boundary: external GitButler diff text enters classifier/model context.
 * Asset: protected credential, encrypted-infrastructure, and key-management file
 * payloads. The fail-closed mitigation keeps file names for diagnosis but strips
 * every protected unified-diff section before classification or persistence.
 */
export const redactProtectedGitButlerResult = (
  request: ProtectedResultRequest,
): ProtectedResult => {
  if (
    request.toolName !== "bash" ||
    typeof request.input.command !== "string" ||
    !GITBUTLER_DIFF_COMMAND.test(request.input.command)
  )
    return { content: request.content, redacted: false }

  const containsProtectedPath = request.content.some(
    item => item.type === "text" && PROTECTED_DIFF_PATH.test(item.text),
  )
  let redacted = false
  const content = request.content.map(item => {
    if (
      typeof item !== "object" ||
      item === null ||
      !("type" in item) ||
      item.type !== "text" ||
      !("text" in item) ||
      typeof item.text !== "string"
    )
      return item
    const sanitized = redactProtectedDiffText(item.text)
    redacted ||= sanitized.redacted
    return sanitized.redacted ? { ...item, text: sanitized.text } : item
  })

  if (redacted) return { content, redacted: true }
  if (containsProtectedPath)
    return {
      content: [
        {
          type: "text",
          text: "[unrecognized protected diff format withheld]",
        },
      ],
      redacted: true,
    }
  return { content: request.content, redacted: false }
}
