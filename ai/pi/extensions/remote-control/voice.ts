import * as Data from "effect/Data"
import * as Effect from "effect/Effect"

import { MAX_REMOTE_MESSAGE_CHARACTERS } from "./protocol.ts"
import {
  MAX_TELEGRAM_VOICE_BYTES,
  TelegramContractError,
} from "./telegram.ts"

export class VoiceTranscriptionError extends Data.TaggedError(
  "VoiceTranscriptionError",
)<{ readonly message: string }> {}

const isRecord = (input: unknown): input is Readonly<Record<string, unknown>> =>
  typeof input === "object" && input !== null && !Array.isArray(input)

const startsWith = (
  bytes: Uint8Array,
  prefix: readonly number[],
  offset = 0,
): boolean =>
  offset + prefix.length <= bytes.length &&
  prefix.every((byte, index) => bytes[offset + index] === byte)

const readUint32LittleEndian = (bytes: Uint8Array, offset: number): number =>
  ((bytes[offset] ?? 0) |
    ((bytes[offset + 1] ?? 0) << 8) |
    ((bytes[offset + 2] ?? 0) << 16) |
    ((bytes[offset + 3] ?? 0) << 24)) >>>
  0

const oggPageChecksum = (page: Uint8Array): number => {
  let checksum = 0
  for (let index = 0; index < page.length; index += 1) {
    const byte = index >= 22 && index <= 25 ? 0 : (page[index] ?? 0)
    checksum = (checksum ^ (byte << 24)) >>> 0
    for (let bit = 0; bit < 8; bit += 1) {
      checksum =
        checksum & 0x80000000
          ? ((checksum << 1) ^ 0x04c11db7) >>> 0
          : (checksum << 1) >>> 0
    }
  }
  return checksum
}

const validOggOpusIdentificationPage = (bytes: Uint8Array): boolean => {
  if (
    bytes.length < 47 ||
    !startsWith(bytes, [0x4f, 0x67, 0x67, 0x53]) ||
    bytes[4] !== 0 ||
    ((bytes[5] ?? 0) & 0x01) !== 0 ||
    ((bytes[5] ?? 0) & 0x02) === 0 ||
    readUint32LittleEndian(bytes, 18) !== 0
  )
    return false

  const segmentCount = bytes[26] ?? 0
  const headerLength = 27 + segmentCount
  if (segmentCount < 1 || headerLength > bytes.length) return false

  let payloadLength = 0
  let firstPacketLength = 0
  let firstPacketComplete = false
  for (let index = 0; index < segmentCount; index += 1) {
    const length = bytes[27 + index] ?? 0
    payloadLength += length
    if (!firstPacketComplete) {
      firstPacketLength += length
      firstPacketComplete = length < 255
    }
  }
  const pageLength = headerLength + payloadLength
  if (
    !firstPacketComplete ||
    firstPacketLength !== 19 ||
    pageLength > bytes.length ||
    oggPageChecksum(bytes.slice(0, pageLength)) !==
      readUint32LittleEndian(bytes, 22)
  )
    return false

  const packetOffset = headerLength
  const channels = bytes[packetOffset + 9] ?? 0
  return (
    startsWith(
      bytes,
      [0x4f, 0x70, 0x75, 0x73, 0x48, 0x65, 0x61, 0x64],
      packetOffset,
    ) &&
    bytes[packetOffset + 8] === 1 &&
    (channels === 1 || channels === 2) &&
    bytes[packetOffset + 18] === 0
  )
}

export const telegramVoiceFromBytes = (
  contentType: string,
  bytes: Uint8Array,
): Effect.Effect<Uint8Array, TelegramContractError> => {
  const normalizedType = contentType.split(";", 1)[0]?.trim().toLowerCase()
  const allowedType =
    normalizedType === "audio/ogg" ||
    normalizedType === "audio/opus" ||
    normalizedType === "application/octet-stream" ||
    normalizedType === ""
  if (
    !allowedType ||
    bytes.byteLength > MAX_TELEGRAM_VOICE_BYTES ||
    !validOggOpusIdentificationPage(bytes)
  ) {
    return Effect.fail(
      new TelegramContractError({
        message: "Telegram voice media type is invalid",
      }),
    )
  }
  return Effect.succeed(bytes)
}

export const decodeWhisperTranscript = (
  input: unknown,
): Effect.Effect<string, VoiceTranscriptionError> => {
  if (!isRecord(input) || !Array.isArray(input.transcription)) {
    return Effect.fail(
      new VoiceTranscriptionError({
        message: "Whisper transcription response is invalid",
      }),
    )
  }
  const segments: string[] = []
  for (const segment of input.transcription) {
    if (!isRecord(segment) || typeof segment.text !== "string") {
      return Effect.fail(
        new VoiceTranscriptionError({
          message: "Whisper transcription segment is invalid",
        }),
      )
    }
    const text = segment.text.trim()
    if (text) segments.push(text)
  }
  const transcript = segments.join(" ").replace(/\s+/gu, " ").trim()
  if (
    transcript.length < 1 ||
    transcript.length > MAX_REMOTE_MESSAGE_CHARACTERS
  ) {
    return Effect.fail(
      new VoiceTranscriptionError({
        message: "Whisper transcription is empty or too long",
      }),
    )
  }
  return Effect.succeed(transcript)
}

export const replaceVoiceMarker = (
  text: string,
  messageId: number,
  transcript: string,
): Effect.Effect<string, VoiceTranscriptionError> => {
  const marker = `[Voice message #${messageId}]`
  if (!text.includes(marker)) {
    return Effect.fail(
      new VoiceTranscriptionError({
        message: "Voice transcript marker is missing",
      }),
    )
  }
  return Effect.succeed(text.replaceAll(marker, transcript).trim())
}

export const whisperCliArguments = (
  modelPath: string,
  inputPath: string,
  outputPrefix: string,
): readonly string[] => [
  "-m",
  modelPath,
  "-f",
  inputPath,
  "-l",
  "auto",
  "-oj",
  "-of",
  outputPrefix,
  "-np",
  "-nt",
  "-sns",
]
