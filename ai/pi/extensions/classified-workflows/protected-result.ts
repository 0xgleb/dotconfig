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

interface DiffScanState {
  readonly protectedSection: boolean
  readonly safeSection: boolean
  readonly oldRemaining: number
  readonly newRemaining: number
  readonly hunkProtectedReference: boolean
  readonly unresolved: boolean
}

const initialScanState: DiffScanState = {
  protectedSection: false,
  safeSection: false,
  oldRemaining: 0,
  newRemaining: 0,
  hunkProtectedReference: false,
  unresolved: false,
}

const literalDiffHeader =
  /^diff --git (?:"(?:[^"\\]|\\.)+"|\S+) (?:"(?:[^"\\]|\\.)+"|\S+)$/
const hunkHeader = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@(?:.*)$/

const scanDiffText = (text: string, previous: DiffScanState) => {
  const output: string[] = []
  let state = previous
  let redacted = false
  for (const line of text.split("\n")) {
    if (DIFF_SECTION_HEADER.test(line)) {
      const protectedSection = PROTECTED_DIFF_PATH.test(line)
      state = {
        ...initialScanState,
        protectedSection,
        safeSection: !protectedSection && literalDiffHeader.test(line),
        unresolved:
          state.unresolved ||
          state.hunkProtectedReference ||
          (!protectedSection && !literalDiffHeader.test(line)),
      }
      output.push(line)
      if (protectedSection) {
        output.push(REDACTION_MARKER)
        redacted = true
      }
      continue
    }
    if (state.protectedSection) {
      redacted = true
      continue
    }
    if (state.oldRemaining > 0 || state.newRemaining > 0) {
      const oldRemaining =
        state.oldRemaining -
        (line.startsWith("-") || line.startsWith(" ") ? 1 : 0)
      const newRemaining =
        state.newRemaining -
        (line.startsWith("+") || line.startsWith(" ") ? 1 : 0)
      const valid =
        /^[+ -]/.test(line) && oldRemaining >= 0 && newRemaining >= 0
      const hasReference =
        state.hunkProtectedReference || PROTECTED_DIFF_PATH.test(line)
      state = valid
        ? {
            ...state,
            oldRemaining,
            newRemaining,
            hunkProtectedReference:
              hasReference && (oldRemaining > 0 || newRemaining > 0),
          }
        : {
            ...state,
            oldRemaining: 0,
            newRemaining: 0,
            hunkProtectedReference: false,
            unresolved: state.unresolved || hasReference,
            safeSection: false,
          }
      output.push(line)
      continue
    }
    if (FILE_SECTION_HEADER.test(line)) {
      if (PROTECTED_DIFF_PATH.test(line)) {
        state = { ...state, protectedSection: true, safeSection: false }
        output.push(line, REDACTION_MARKER)
        redacted = true
      } else output.push(line)
      continue
    }
    const hunk = state.safeSection ? hunkHeader.exec(line) : null
    if (hunk) {
      const oldRemaining = Number(hunk[1] ?? 1)
      const newRemaining = Number(hunk[2] ?? 1)
      const valid =
        Number.isSafeInteger(oldRemaining) && Number.isSafeInteger(newRemaining)
      state = {
        ...state,
        oldRemaining: valid ? oldRemaining : 0,
        newRemaining: valid ? newRemaining : 0,
        safeSection: valid,
      }
    } else if (PROTECTED_DIFF_PATH.test(line)) {
      state = { ...state, unresolved: true }
    }
    output.push(line)
  }
  return { text: output.join("\n"), state, redacted }
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

  let state = initialScanState
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
    const scanned = scanDiffText(item.text, state)
    state = scanned.state
    redacted ||= scanned.redacted
    return scanned.redacted ? { ...item, text: scanned.text } : item
  })

  if (state.unresolved || state.hunkProtectedReference)
    return {
      content: request.content.map(item =>
        item.type === "text"
          ? { ...item, text: "[unrecognized protected diff format withheld]" }
          : item,
      ),
      redacted: true,
    }
  return redacted
    ? { content, redacted: true }
    : { content: request.content, redacted: false }
}
