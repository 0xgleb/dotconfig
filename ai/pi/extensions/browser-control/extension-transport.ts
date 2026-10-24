import { createHash, timingSafeEqual } from "node:crypto"
import { Data, Effect, Either } from "effect"
import { decodeExtensionFrame } from "./extension-protocol.ts"

/**
 * Pure core of the loopback WebSocket transport the Pi host serves for the
 * agent-profile browser extension (ADR 08). Everything here is a total
 * function over bytes and headers so the socket wiring stays a thin shell:
 * handshake admission (exact chrome-extension Origin, RFC 6455 accept key),
 * client frame decoding with fail-closed protocol violations, server frame
 * encoding, token minting for provisioning, and hello-frame admission
 * against the provisioned token and operator profile.
 */
export const MAX_CLIENT_FRAME_BYTES = 1_048_576
export const TRANSPORT_TOKEN_ENTROPY_BYTES = 32

export class BrowserTransportError extends Data.TaggedError(
  "BrowserTransportError",
)<{
  readonly code: "invalid_input" | "response_limit"
  readonly message: string
}> {}

const transportFailure = (
  code: BrowserTransportError["code"],
  message: string,
): Effect.Effect<never, BrowserTransportError> =>
  Effect.fail(new BrowserTransportError({ code, message }))

export interface HandshakeRequest {
  readonly method: string
  readonly headers: Readonly<Record<string, string | undefined>>
}

export type HandshakeDecision =
  | { readonly outcome: "accepted"; readonly acceptKey: string }
  | { readonly outcome: "rejected"; readonly reason: string }

export type FrameEvent =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "ping"; readonly payload: Uint8Array }
  | { readonly kind: "close" }

export type ClientFrameResult =
  | {
      readonly outcome: "frames"
      readonly events: readonly FrameEvent[]
      readonly rest: Uint8Array
    }
  | { readonly outcome: "violation"; readonly reason: string }

export type HelloDecision =
  | { readonly outcome: "accepted" }
  | { readonly outcome: "rejected"; readonly reason: string }

export interface ProvisionedIdentity {
  readonly token: string
  readonly profilePath: string
}

export const decideHandshake: (
  request: HandshakeRequest,
  expectedOrigin: string,
) => HandshakeDecision = (request, expectedOrigin) => {
  if (request.method !== "GET")
    return rejected("handshake must be a GET request")
  const headers = request.headers
  if (headers.origin !== expectedOrigin) {
    return rejected("origin is not the provisioned extension")
  }
  if (headers.upgrade?.toLowerCase() !== "websocket") {
    return rejected("upgrade header must be websocket")
  }
  const connectionTokens = (headers.connection ?? "")
    .split(",")
    .map(token => token.trim().toLowerCase())
  if (!connectionTokens.includes("upgrade")) {
    return rejected("connection header must include upgrade")
  }
  if (headers["sec-websocket-version"] !== "13") {
    return rejected("unsupported websocket version")
  }
  const key = headers["sec-websocket-key"]
  if (key === undefined || !isSixteenByteBase64(key)) {
    return rejected("sec-websocket-key must be sixteen base64 bytes")
  }
  return {
    outcome: "accepted",
    acceptKey: createHash("sha1")
      .update(key + WEBSOCKET_GUID)
      .digest("base64"),
  }
}

export const decodeClientFrames: (
  buffer: Uint8Array,
  maxPayloadBytes: number,
) => ClientFrameResult = (buffer, maxPayloadBytes) => {
  const events: FrameEvent[] = []
  let offset = 0
  while (buffer.length - offset >= 2) {
    const first = buffer[offset] ?? 0
    const second = buffer[offset + 1] ?? 0
    if ((first & 0x70) !== 0) return violation("reserved bits must be zero")
    if ((first & 0x80) === 0)
      return violation("fragmented frames are not supported")
    if ((second & 0x80) === 0) return violation("client frames must be masked")
    const opcode = first & 0x0f
    let payloadLength = second & 0x7f
    const controlFrame = opcode === 0x8 || opcode === 0x9 || opcode === 0xa
    if (controlFrame && payloadLength >= 126)
      return violation("control frames must use a payload of at most 125 bytes")
    let headerLength = 2
    if (payloadLength === 126) {
      if (buffer.length - offset < 4) break
      payloadLength =
        ((buffer[offset + 2] ?? 0) << 8) | (buffer[offset + 3] ?? 0)
      headerLength = 4
    } else if (payloadLength === 127) {
      return violation(
        "sixty-four bit frame lengths exceed the transport bound",
      )
    }
    if (payloadLength > maxPayloadBytes)
      return violation("frame exceeds the payload bound")
    const frameLength = headerLength + 4 + payloadLength
    if (buffer.length - offset < frameLength) break
    const mask = buffer.subarray(
      offset + headerLength,
      offset + headerLength + 4,
    )
    const payload = new Uint8Array(payloadLength)
    for (let index = 0; index < payloadLength; index += 1) {
      payload[index] =
        (buffer[offset + headerLength + 4 + index] ?? 0) ^
        (mask[index % 4] ?? 0)
    }
    if (opcode === 0x1) {
      let text: string
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(payload)
      } catch {
        return violation("text frame payload is not valid utf-8")
      }
      events.push({ kind: "text", text })
    } else if (opcode === 0x8) {
      events.push({ kind: "close" })
    } else if (opcode === 0x9) {
      events.push({ kind: "ping", payload })
    } else if (opcode !== 0xa) {
      return violation("unsupported frame opcode")
    }
    offset += frameLength
  }
  return { outcome: "frames", events, rest: buffer.subarray(offset) }
}

export const encodeTextFrame = (
  text: string,
): Effect.Effect<Uint8Array, BrowserTransportError> =>
  Effect.gen(function* () {
    const payload = new TextEncoder().encode(text)
    if (payload.length < 126) {
      const frame = new Uint8Array(2 + payload.length)
      frame[0] = 0x81
      frame[1] = payload.length
      frame.set(payload, 2)
      return frame
    }
    if (payload.length > 0xffff)
      return yield* transportFailure(
        "response_limit",
        "server frames are bounded to sixteen-bit lengths",
      )
    const frame = new Uint8Array(4 + payload.length)
    frame[0] = 0x81
    frame[1] = 126
    frame[2] = payload.length >> 8
    frame[3] = payload.length & 0xff
    frame.set(payload, 4)
    return frame
  })

export const encodePongFrame = (
  payload: Uint8Array,
): Effect.Effect<Uint8Array, BrowserTransportError> =>
  Effect.gen(function* () {
    if (payload.length >= 126)
      return yield* transportFailure(
        "response_limit",
        "control frame payloads are bounded to 125 bytes",
      )
    const frame = new Uint8Array(2 + payload.length)
    frame[0] = 0x8a
    frame[1] = payload.length
    frame.set(payload, 2)
    return frame
  })

export const encodeCloseFrame: () => Uint8Array = () =>
  Uint8Array.from([0x88, 0x00])

export const mintTransportToken = (
  entropy: Uint8Array,
): Effect.Effect<string, BrowserTransportError> =>
  entropy.length < TRANSPORT_TOKEN_ENTROPY_BYTES
    ? transportFailure(
        "invalid_input",
        `transport tokens require at least ${TRANSPORT_TOKEN_ENTROPY_BYTES} bytes of entropy`,
      )
    : Effect.succeed(
        Array.from(entropy, byte => byte.toString(16).padStart(2, "0")).join(
          "",
        ),
      )

export const decideHello: (
  value: unknown,
  provisioned: ProvisionedIdentity,
) => HelloDecision = (value, provisioned) => {
  const frame = Effect.runSync(Effect.either(decodeExtensionFrame(value)))
  if (Either.isLeft(frame))
    return { outcome: "rejected", reason: "hello frame is malformed" }
  if (frame.right.kind !== "hello") {
    return { outcome: "rejected", reason: "first frame must be a hello" }
  }
  const offered = new TextEncoder().encode(frame.right.token)
  const expected = new TextEncoder().encode(provisioned.token)
  if (
    offered.length !== expected.length ||
    !timingSafeEqual(offered, expected)
  ) {
    return {
      outcome: "rejected",
      reason: "token does not match the current provisioning",
    }
  }
  if (frame.right.profilePath !== provisioned.profilePath) {
    return {
      outcome: "rejected",
      reason: "profile is not the operator profile",
    }
  }
  return { outcome: "accepted" }
}

const WEBSOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

const rejected = (reason: string): HandshakeDecision => ({
  outcome: "rejected",
  reason,
})

const violation = (reason: string): ClientFrameResult => ({
  outcome: "violation",
  reason,
})

const isSixteenByteBase64 = (value: string): boolean => {
  try {
    return (
      Buffer.from(value, "base64").length === 16 && btoa(atob(value)) === value
    )
  } catch {
    return false
  }
}
