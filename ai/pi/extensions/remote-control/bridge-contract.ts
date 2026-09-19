import { Data, Effect } from "effect"

export const BRIDGE_PROTOCOL_VERSION = 6
export const BRIDGE_AGENT_TTL_MS = 15_000
export const BRIDGE_MESSAGE_TTL_MS = 60 * 60_000
export const MAX_REMOTE_MESSAGE_CHARACTERS = 4_000
export const MAX_REMOTE_IMAGE_COUNT = 4
export const MAX_REMOTE_IMAGE_BYTES = 8 * 1024 * 1024
export const MAX_REMOTE_IMAGE_TOTAL_BYTES = 12 * 1024 * 1024
export const MAX_REMOTE_RESPONSE_CHARACTERS = 12_000
export const MAX_REMOTE_QUESTION_CHARACTERS = 4_000
export const MAX_REMOTE_ANSWER_CHARACTERS = 4_000

export type RemoteMessageStatus = "queued" | "claimed" | "completed" | "failed"

export const BRIDGE_WORK_DELIVERIES = [
  "native-pi",
  "cli-poll",
  "inline-only",
  "monitor-only",
] as const

export type BridgeWorkDelivery = (typeof BRIDGE_WORK_DELIVERIES)[number]

export const isBridgeWorkDelivery = (
  value: unknown,
): value is BridgeWorkDelivery =>
  typeof value === "string" &&
  BRIDGE_WORK_DELIVERIES.some(candidate => candidate === value)

export const workDeliveryAcceptsInbox = (
  workDelivery: BridgeWorkDelivery,
): boolean => workDelivery === "native-pi" || workDelivery === "cli-poll"

export interface BridgeAgent {
  readonly id: string
  readonly label: string
  readonly cwd: string
  readonly heartbeatAt: number
  readonly expiresAt: number
  readonly accepting: boolean
  readonly workDelivery: BridgeWorkDelivery
  readonly queuedMessages: number
}

export type RemoteImageMediaType = "image/jpeg" | "image/png" | "image/webp"

export interface RemoteImage {
  readonly mediaType: RemoteImageMediaType
  readonly data: string
}

interface RemoteMessageBase {
  readonly id: string
  readonly targetAgentId: string
  readonly requesterId: string
  readonly dedupeKey: string
  readonly text: string
  readonly images: readonly RemoteImage[]
  readonly createdAt: number
  readonly expiresAt: number
  readonly updatedAt: number
}

export type RemoteMessage =
  | (RemoteMessageBase & { readonly status: "queued" })
  | (RemoteMessageBase & {
      readonly status: "claimed"
      readonly claimToken: string
      readonly claimedAt: number
    })
  | (RemoteMessageBase & {
      readonly status: "completed"
      readonly response: string
      readonly completedAt: number
    })
  | (RemoteMessageBase & {
      readonly status: "failed"
      readonly failure: RemoteFailure
      readonly claimedAt?: number
      readonly completedAt: number
    })

export type RemoteFailure =
  "aborted" | "bridge_disabled" | "expired" | "model_error" | "session_ended"

export interface RemoteQuestionOption {
  readonly label: string
  readonly description?: string
}

export interface RemoteQuestionSnapshot {
  readonly id: number
  readonly status: "pending" | "resolved"
  readonly question: string
  readonly header?: string
  readonly guess?: string
  readonly options?: readonly RemoteQuestionOption[]
}

export interface BridgeQuestion {
  readonly agentId: string
  readonly questionId: number
  readonly question: string
  readonly header?: string
  readonly guess?: string
  readonly options?: readonly RemoteQuestionOption[]
  readonly createdAt: number
  readonly updatedAt: number
}

export interface RemoteQuestionResolution {
  readonly agentId: string
  readonly questionId: number
  readonly answer: string
}

export class RemoteBridgeError extends Data.TaggedError("RemoteBridgeError")<{
  readonly code:
    | "busy"
    | "capacity"
    | "corrupt_state"
    | "disabled"
    | "invalid_input"
    | "invalid_transition"
    | "io"
    | "not_found"
    | "stale_agent"
    | "undrainable_agent"
  readonly message: string
}> {}

const hasUnsafeControlCharacters = (text: string): boolean =>
  /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)

export const boundedBridgeTextEffect = (
  label: string,
  text: string,
  maximum: number,
): Effect.Effect<string, RemoteBridgeError> => {
  const trimmed = text.trim()
  return !trimmed ||
    trimmed.length > maximum ||
    hasUnsafeControlCharacters(trimmed)
    ? Effect.fail(
        new RemoteBridgeError({
          code: "invalid_input",
          message: `${label} must contain 1-${maximum} safe characters`,
        }),
      )
    : Effect.succeed(trimmed)
}

export const boundedIdentifierEffect = (
  label: string,
  value: string,
  maximum = 128,
): Effect.Effect<string, RemoteBridgeError> =>
  Effect.flatMap(boundedBridgeTextEffect(label, value, maximum), bounded =>
    /^[A-Za-z0-9._:-]+$/.test(bounded)
      ? Effect.succeed(bounded)
      : Effect.fail(
          new RemoteBridgeError({
            code: "invalid_input",
            message: `${label} has invalid characters`,
          }),
        ),
  )

export const boundedTimestampEffect = (
  label: string,
  value: number,
): Effect.Effect<number, RemoteBridgeError> =>
  !Number.isSafeInteger(value) || value < 0
    ? Effect.fail(
        new RemoteBridgeError({
          code: "invalid_input",
          message: `${label} must be a timestamp`,
        }),
      )
    : Effect.succeed(value)

export const boundedTtlEffect = (
  value: number,
): Effect.Effect<number, RemoteBridgeError> =>
  !Number.isSafeInteger(value) || value < 1_000 || value > 60 * 60_000
    ? Effect.fail(
        new RemoteBridgeError({
          code: "invalid_input",
          message: "ttl must be between 1s and 1h",
        }),
      )
    : Effect.succeed(value)

export const boundedBridgeImagesEffect = (
  images: readonly RemoteImage[],
): Effect.Effect<readonly RemoteImage[], RemoteBridgeError> =>
  Effect.gen(function* () {
    if (images.length > MAX_REMOTE_IMAGE_COUNT)
      return yield* Effect.fail(
        new RemoteBridgeError({
          code: "invalid_input",
          message: `message may contain at most ${MAX_REMOTE_IMAGE_COUNT} images`,
        }),
      )
    let totalBytes = 0
    const bounded: RemoteImage[] = []
    for (const image of images) {
      if (
        image.mediaType !== "image/jpeg" &&
        image.mediaType !== "image/png" &&
        image.mediaType !== "image/webp"
      )
        return yield* Effect.fail(
          new RemoteBridgeError({
            code: "invalid_input",
            message: "image media type is not supported",
          }),
        )
      if (
        !image.data ||
        image.data.length % 4 !== 0 ||
        !/^[A-Za-z0-9+/]*={0,2}$/u.test(image.data)
      )
        return yield* Effect.fail(
          new RemoteBridgeError({
            code: "invalid_input",
            message: "image data is not canonical base64",
          }),
        )
      const bytes = yield* Effect.try({
        try: () => Buffer.from(image.data, "base64"),
        catch: () =>
          new RemoteBridgeError({
            code: "invalid_input",
            message: "image data is not canonical base64",
          }),
      })
      if (bytes.toString("base64") !== image.data)
        return yield* Effect.fail(
          new RemoteBridgeError({
            code: "invalid_input",
            message: "image data is not canonical base64",
          }),
        )
      if (bytes.byteLength > MAX_REMOTE_IMAGE_BYTES)
        return yield* Effect.fail(
          new RemoteBridgeError({
            code: "invalid_input",
            message: `image exceeds ${MAX_REMOTE_IMAGE_BYTES} bytes`,
          }),
        )
      totalBytes += bytes.byteLength
      if (totalBytes > MAX_REMOTE_IMAGE_TOTAL_BYTES)
        return yield* Effect.fail(
          new RemoteBridgeError({
            code: "invalid_input",
            message: `images exceed ${MAX_REMOTE_IMAGE_TOTAL_BYTES} bytes in total`,
          }),
        )
      bounded.push(image)
    }
    return bounded
  })
