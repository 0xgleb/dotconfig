import { redactTemporaryScreenshotForEditor } from "../input-ergonomics/core.ts"

export interface EditorAttachmentState {
  readonly nextId: number
  readonly paths: ReadonlyMap<string, string>
}

export interface PendingEditorAttachment {
  readonly marker: string
  readonly path: string
}

const PENDING_DESCRIPTION = "describing image…"
const MAX_EDITOR_CAPTION_CHARACTERS = 120

export const emptyEditorAttachmentState: () => EditorAttachmentState = () => ({
  nextId: 1,
  paths: new Map(),
})

const attachmentMarker = (id: number, caption: string): string =>
  `[Image ${id}: ${caption}]`

const reserveAttachmentBlock = (text: string, marker: string): string => {
  const markerIndex = text.indexOf(marker)
  if (markerIndex < 0) return text
  const before = text
    .slice(0, markerIndex)
    .replace(/[ \t]+$/u, "")
    .replace(/\n+$/u, "")
  const after = text
    .slice(markerIndex + marker.length)
    .replace(/^[ \t]+/u, "")
    .replace(/^\n+/u, "")
  return `${before.length > 0 ? `${before}\n\n` : ""}${marker}\n\n${after}`
}

export const redactEditorScreenshot: (
  text: string,
  state: EditorAttachmentState,
) => { readonly text: string; readonly state: EditorAttachmentState } = (
  text,
  state,
) => {
  let displayText = text
  let nextId = state.nextId
  const paths = new Map(state.paths)

  while (true) {
    const marker = attachmentMarker(nextId, PENDING_DESCRIPTION)
    const redaction = redactTemporaryScreenshotForEditor(displayText, marker)
    if (!redaction) break
    displayText = reserveAttachmentBlock(redaction.displayText, marker)
    paths.set(marker, redaction.pathText)
    nextId += 1
  }

  return nextId === state.nextId
    ? { text, state }
    : { text: displayText, state: { nextId, paths } }
}

export const pendingEditorAttachments = (
  previous: EditorAttachmentState,
  current: EditorAttachmentState,
): readonly PendingEditorAttachment[] =>
  [...current.paths].flatMap(([marker, path]) =>
    previous.paths.has(marker) ? [] : [{ marker, path }],
  )

export const isCurrentEditorAttachment = (
  state: EditorAttachmentState,
  attachment: PendingEditorAttachment,
): boolean => state.paths.get(attachment.marker) === attachment.path

const boundedEditorCaption = (caption: string): string | undefined => {
  const normalized = caption.trim().replace(/[\p{Cc}\p{Cs}\r\n]+/gu, " ")
  return normalized.length > 0 &&
    normalized.length <= MAX_EDITOR_CAPTION_CHARACTERS
    ? normalized
    : undefined
}

export const resolveEditorAttachmentCaption = (
  text: string,
  state: EditorAttachmentState,
  marker: string,
  caption: string,
): { readonly text: string; readonly state: EditorAttachmentState } => {
  const path = state.paths.get(marker)
  const bounded = boundedEditorCaption(caption)
  if (!path || !bounded || !text.includes(marker)) return { text, state }
  const id = Number(marker.match(/^\[Image (\d+):/u)?.[1])
  if (!Number.isSafeInteger(id) || id < 1) return { text, state }
  const describedMarker = attachmentMarker(id, bounded)
  const paths = new Map(state.paths)
  paths.delete(marker)
  paths.set(describedMarker, path)
  return {
    text: text.replaceAll(marker, describedMarker),
    state: { nextId: state.nextId, paths },
  }
}

export const expandEditorScreenshots: (
  text: string,
  state: EditorAttachmentState,
) => string = (text, state) => {
  let expanded = text
  for (const [marker, path] of state.paths)
    expanded = expanded.replaceAll(marker, path)
  return expanded
}
