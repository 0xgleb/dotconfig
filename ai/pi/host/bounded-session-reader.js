import { closeSync, openSync, readSync } from "node:fs"
import { StringDecoder } from "node:string_decoder"

export const MAX_SESSION_ENTRY_BYTES = 16 * 1024 * 1024

const DEFAULT_READ_BUFFER_BYTES = 1024 * 1024
const MAX_METADATA_PREFIX_CHARACTERS = 64 * 1024
const MESSAGE_PAYLOAD_MARKER = ',"message":'

const parseEntry = line => {
  if (line.length === 0 || /^\s+$/u.test(line)) return undefined
  try {
    return JSON.parse(line)
  } catch {
    return undefined
  }
}

const appendMetadataPrefix = (prefix, fragment) => {
  const remaining = MAX_METADATA_PREFIX_CHARACTERS - prefix.length
  return remaining <= 0 ? prefix : prefix + fragment.slice(0, remaining)
}

const oversizedEntryPlaceholder = (prefix, maxEntryBytes) => {
  const payloadBoundary = prefix.indexOf(MESSAGE_PAYLOAD_MARKER)
  if (payloadBoundary < 0) return undefined

  const metadata = parseEntry(`${prefix.slice(0, payloadBoundary)}}`)
  if (
    metadata?.type !== "message" ||
    typeof metadata.id !== "string" ||
    (metadata.parentId !== null && typeof metadata.parentId !== "string") ||
    typeof metadata.timestamp !== "string"
  ) {
    return undefined
  }

  return {
    type: "custom_message",
    id: metadata.id,
    parentId: metadata.parentId,
    timestamp: metadata.timestamp,
    customType: "oversized_session_entry",
    content: [
      {
        type: "text",
        text: `[Session entry omitted: exceeded ${maxEntryBytes}-byte safety limit]`,
      },
    ],
    display: true,
    details: {
      originalType: metadata.type,
      maxEntryBytes,
    },
  }
}

export function loadBoundedSessionEntriesSync(filePath) {
  const entries = []
  const decoder = new StringDecoder("utf8")
  const buffer = Buffer.allocUnsafe(DEFAULT_READ_BUFFER_BYTES)
  let pending = ""
  let pendingBytes = 0
  let oversizedPrefix

  const appendFragment = fragment => {
    if (oversizedPrefix !== undefined) return
    const fragmentBytes = Buffer.byteLength(fragment, "utf8")
    if (pendingBytes + fragmentBytes <= MAX_SESSION_ENTRY_BYTES) {
      pending += fragment
      pendingBytes += fragmentBytes
      return
    }
    oversizedPrefix = appendMetadataPrefix(pending, fragment)
    pending = ""
    pendingBytes = 0
  }

  const finishLine = () => {
    const entry =
      oversizedPrefix === undefined
        ? parseEntry(pending)
        : oversizedEntryPlaceholder(oversizedPrefix, MAX_SESSION_ENTRY_BYTES)
    if (entry !== undefined) entries.push(entry)
    pending = ""
    pendingBytes = 0
    oversizedPrefix = undefined
  }

  const acceptText = text => {
    let lineStart = 0
    let newlineIndex = text.indexOf("\n", lineStart)
    while (newlineIndex !== -1) {
      appendFragment(text.slice(lineStart, newlineIndex))
      finishLine()
      lineStart = newlineIndex + 1
      newlineIndex = text.indexOf("\n", lineStart)
    }
    appendFragment(text.slice(lineStart))
  }

  const fd = openSync(filePath, "r")
  try {
    while (true) {
      const bytesRead = readSync(fd, buffer, 0, buffer.length, null)
      if (bytesRead === 0) break
      acceptText(decoder.write(buffer.subarray(0, bytesRead)))
    }
    acceptText(decoder.end())
    if (pending.length > 0 || oversizedPrefix !== undefined) finishLine()
    return entries
  } finally {
    closeSync(fd)
  }
}
