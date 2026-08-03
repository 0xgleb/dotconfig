import assert from "node:assert/strict"
import test from "node:test"
import * as Effect from "effect/Effect"
import * as Either from "effect/Either"

import {
  decodeWhisperTranscript,
  replaceVoiceMarker,
  telegramVoiceFromBytes,
  whisperCliArguments,
} from "./voice.ts"

const oggChecksum = (page: Uint8Array): number => {
  let checksum = 0
  for (let index = 0; index < page.length; index += 1) {
    const byte = index >= 22 && index <= 25 ? 0 : (page[index] ?? 0)
    checksum = (checksum ^ (byte << 24)) >>> 0
    for (let bit = 0; bit < 8; bit += 1)
      checksum =
        checksum & 0x80000000
          ? ((checksum << 1) ^ 0x04c11db7) >>> 0
          : (checksum << 1) >>> 0
  }
  return checksum
}

const stampOggChecksum = (bytes: Uint8Array): Uint8Array => {
  bytes.fill(0, 22, 26)
  const segmentCount = bytes[26] ?? 0
  let payloadLength = 0
  for (let index = 0; index < segmentCount; index += 1)
    payloadLength += bytes[27 + index] ?? 0
  const pageLength = 27 + segmentCount + payloadLength
  const checksum = oggChecksum(bytes.slice(0, pageLength))
  bytes[22] = checksum & 0xff
  bytes[23] = (checksum >>> 8) & 0xff
  bytes[24] = (checksum >>> 16) & 0xff
  bytes[25] = (checksum >>> 24) & 0xff
  return bytes
}

const oggOpus = (): Uint8Array => {
  const bytes = new Uint8Array(47)
  bytes.set(new TextEncoder().encode("OggS"), 0)
  bytes[4] = 0
  bytes[5] = 2
  bytes[14] = 1
  bytes[26] = 1
  bytes[27] = 19
  bytes.set(new TextEncoder().encode("OpusHead"), 28)
  bytes[36] = 1
  bytes[37] = 1
  bytes[38] = 0x38
  bytes[39] = 0x01
  bytes[40] = 0x80
  bytes[41] = 0xbb
  bytes[46] = 0
  return stampOggChecksum(bytes)
}

const mutateValidOgg = (
  mutation: (bytes: Uint8Array) => void,
): Uint8Array => {
  const bytes = oggOpus()
  mutation(bytes)
  return stampOggChecksum(bytes)
}

test("Telegram voice bytes require bounded Ogg Opus content", async () => {
  const decoded = await Effect.runPromise(
    telegramVoiceFromBytes("application/octet-stream", oggOpus()),
  )
  assert.deepEqual(decoded, oggOpus())

  const invalidCases = [
    { name: "media type", contentType: "audio/mpeg", bytes: oggOpus() },
    {
      name: "truncated page",
      contentType: "audio/ogg",
      bytes: new TextEncoder().encode("OggS-not-opus"),
    },
    {
      name: "Ogg version",
      contentType: "audio/ogg",
      bytes: mutateValidOgg((bytes) => {
        bytes[4] = 1
      }),
    },
    {
      name: "BOS flag",
      contentType: "audio/ogg",
      bytes: mutateValidOgg((bytes) => {
        bytes[5] = 0
      }),
    },
    {
      name: "segment table",
      contentType: "audio/ogg",
      bytes: mutateValidOgg((bytes) => {
        bytes[27] = 18
      }),
    },
    {
      name: "OpusHead packet",
      contentType: "audio/ogg",
      bytes: mutateValidOgg((bytes) => {
        bytes[28] = 0
      }),
    },
    {
      name: "checksum",
      contentType: "audio/ogg",
      bytes: (() => {
        const bytes = oggOpus()
        bytes[22] ^= 0xff
        return bytes
      })(),
    },
    {
      name: "byte limit",
      contentType: "audio/ogg",
      bytes: new Uint8Array(8 * 1024 * 1024 + 1),
    },
  ] as const
  for (const invalid of invalidCases) {
    const result = await Effect.runPromise(
      Effect.either(
        telegramVoiceFromBytes(invalid.contentType, invalid.bytes),
      ),
    )
    assert.equal(Either.isLeft(result), true, invalid.name)
  }
})

test("Whisper JSON decodes only a bounded non-empty transcript", async () => {
  assert.equal(
    await Effect.runPromise(
      decodeWhisperTranscript({
        transcription: [{ text: "  Shit, I want to reply " }, { text: " with voice. " }],
      }),
    ),
    "Shit, I want to reply with voice.",
  )

  for (const input of [
    { transcription: [] },
    { transcription: [{ text: "" }] },
    { transcription: [{ text: 42 }] },
    { transcription: [{ text: "x".repeat(4_001) }] },
  ]) {
    const result = await Effect.runPromise(
      Effect.either(decodeWhisperTranscript(input)),
    )
    assert.equal(Either.isLeft(result), true)
  }
})

test("voice markers preserve burst order and cannot become spoken commands", async () => {
  assert.equal(
    await Effect.runPromise(
      replaceVoiceMarker(
        "before\n\n[Voice message #9]\n\nafter",
        9,
        "/agents please",
      ),
    ),
    "before\n\n/agents please\n\nafter",
  )
  const missing = await Effect.runPromise(
    Effect.either(replaceVoiceMarker("no marker", 9, "transcript")),
  )
  assert.equal(Either.isLeft(missing), true)
})

test("Whisper runs with an exact source-owned argument vector", () => {
  assert.deepEqual(
    whisperCliArguments("/nix/store/model", "/tmp/input.ogg", "/tmp/result"),
    [
      "-m",
      "/nix/store/model",
      "-f",
      "/tmp/input.ogg",
      "-l",
      "auto",
      "-oj",
      "-of",
      "/tmp/result",
      "-np",
      "-nt",
      "-sns",
    ],
  )
})
