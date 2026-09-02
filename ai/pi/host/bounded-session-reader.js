import { closeSync, fstatSync, openSync, readSync } from "node:fs"
import { StringDecoder } from "node:string_decoder"

export const MAX_SESSION_ENTRY_BYTES = 16 * 1024 * 1024
export const MAX_SESSION_LOAD_BYTES = 32 * 1024 * 1024

export const sessionFileNeedsTrailingNewlineSync = filePath => {
  const fd = openSync(filePath, "r")
  try {
    const fileSize = fstatSync(fd).size
    if (fileSize === 0) return false
    const lastByte = Buffer.allocUnsafe(1)
    const bytesRead = readSync(fd, lastByte, 0, 1, fileSize - 1)
    if (bytesRead !== 1)
      throw new Error("Could not inspect the final session-file byte")
    return lastByte[0] !== 0x0a
  } finally {
    closeSync(fd)
  }
}

export function loadBoundedSessionEntriesSync(filePath) {
  const fd = openSync(filePath, "r")
  try {
    const fileSize = fstatSync(fd).size
    if (fileSize <= MAX_SESSION_LOAD_BYTES)
      return loadEntriesRangeSync(fd, 0, fileSize)

    const header = readSessionHeaderSync(fd)
    const tail = loadEntriesRangeSync(
      fd,
      fileSize - MAX_SESSION_LOAD_BYTES,
      fileSize,
    )
    if (header === undefined) return tail
    const truncation = truncatedHistoryEntry(
      header,
      fileSize - MAX_SESSION_LOAD_BYTES,
    )
    if (truncation === undefined) return [header, ...tail]
    return [header, truncation, ...reparentFirstEntry(tail, truncation.id)]
  } finally {
    closeSync(fd)
  }
}

const DEFAULT_READ_BUFFER_BYTES = 1024 * 1024
const MAX_SESSION_HEADER_BYTES = 1024 * 1024
const MAX_METADATA_PREFIX_CHARACTERS = 64 * 1024
const MESSAGE_PAYLOAD_MARKER = ',"message":'

const parseEntry = line => {
  if (line.length === 0) return undefined
  try {
    return JSON.parse(line)
  } catch {
    return undefined
  }
}

const truncatedHistoryEntry = (header, omittedBytes) => {
  if (
    header?.type !== "session" ||
    typeof header.id !== "string" ||
    typeof header.timestamp !== "string"
  ) {
    return undefined
  }

  return {
    type: "custom_message",
    id: `truncated-session-history-${header.id}`,
    parentId: null,
    timestamp: header.timestamp,
    customType: "truncated_session_history",
    content: [
      {
        type: "text",
        text: `[Earlier session history omitted: exceeded ${MAX_SESSION_LOAD_BYTES}-byte load safety limit]`,
      },
    ],
    display: true,
    details: {
      omittedBytes,
      maxLoadBytes: MAX_SESSION_LOAD_BYTES,
    },
  }
}

const reparentFirstEntry = (entries, parentId) => {
  const first = entries[0]
  if (typeof first !== "object" || first === null) return entries
  return [{ ...first, parentId }, ...entries.slice(1)]
}

const readSessionHeaderSync = fd => {
  const decoder = new StringDecoder("utf8")
  const buffer = Buffer.allocUnsafe(
    Math.min(DEFAULT_READ_BUFFER_BYTES, MAX_SESSION_HEADER_BYTES),
  )
  let position = 0
  let pending = ""

  while (position < MAX_SESSION_HEADER_BYTES) {
    const bytesToRead = Math.min(
      buffer.length,
      MAX_SESSION_HEADER_BYTES - position,
    )
    const bytesRead = readSync(fd, buffer, 0, bytesToRead, position)
    if (bytesRead === 0) break
    position += bytesRead
    pending += decoder.write(buffer.subarray(0, bytesRead))
    const newlineIndex = pending.indexOf("\n")
    if (newlineIndex !== -1) return parseEntry(pending.slice(0, newlineIndex))
  }

  pending += decoder.end()
  return parseEntry(pending)
}

const startsInsideLine = (fd, position) => {
  if (position === 0) return false
  const previousByte = Buffer.allocUnsafe(1)
  return readSync(fd, previousByte, 0, 1, position - 1) === 1
    ? previousByte[0] !== 0x0a
    : false
}

const loadEntriesRangeSync = (fd, startPosition, endPosition) => {
  const entries = []
  const decoder = new StringDecoder("utf8")
  const buffer = Buffer.allocUnsafe(DEFAULT_READ_BUFFER_BYTES)
  let pending = ""
  let pendingBytes = 0
  let oversizedPrefix
  let position = startPosition
  let skipPartialLine = startsInsideLine(fd, startPosition)

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

  while (position < endPosition) {
    const bytesToRead = Math.min(buffer.length, endPosition - position)
    const bytesRead = readSync(fd, buffer, 0, bytesToRead, position)
    if (bytesRead === 0) break
    position += bytesRead
    let fragment = buffer.subarray(0, bytesRead)
    if (skipPartialLine) {
      const newlineIndex = fragment.indexOf(0x0a)
      if (newlineIndex === -1) continue
      fragment = fragment.subarray(newlineIndex + 1)
      skipPartialLine = false
    }
    acceptText(decoder.write(fragment))
  }

  acceptText(decoder.end())
  if (pending.length > 0 || oversizedPrefix !== undefined) finishLine()
  return entries
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
