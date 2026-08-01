import * as Data from "effect/Data"
import * as Effect from "effect/Effect"

export interface TelegramBotState {
  readonly ownerUserId?: number
}

export interface TelegramMessage {
  readonly chatId: number
  readonly messageId: number
  readonly userId: number
  readonly username?: string
  readonly text: string
  readonly replyToMessageId?: number
}

export interface TelegramUpdate {
  readonly updateId: number
  readonly message: TelegramMessage
}

export type TelegramAuthorization =
  | {
      readonly kind: "owner"
      readonly ownerPinned: boolean
      readonly state: TelegramBotState
    }
  | {
      readonly kind: "rejected"
      readonly state: TelegramBotState
    }

export interface ClankerRejection {
  readonly text: string
  readonly nextCounter: number
}

export class TelegramContractError extends Data.TaggedError(
  "TelegramContractError",
)<{ readonly message: string }> {}

export const initialTelegramBotState: TelegramBotState = {}

const isRecord = (input: unknown): input is Readonly<Record<string, unknown>> =>
  typeof input === "object" && input !== null && !Array.isArray(input)

const isSafeInteger = (input: unknown): input is number =>
  Number.isSafeInteger(input)

const normalizedUsername = (username: string | undefined): string | undefined =>
  username?.trim().replace(/^@/, "").toLowerCase() || undefined

export const authorizeTelegramMessage = (
  state: TelegramBotState,
  message: TelegramMessage,
  ownerUsername: string,
): TelegramAuthorization => {
  const usernameMatches =
    normalizedUsername(message.username) === normalizedUsername(ownerUsername)
  if (state.ownerUserId === undefined) {
    return usernameMatches
      ? {
          kind: "owner",
          ownerPinned: true,
          state: { ...state, ownerUserId: message.userId },
        }
      : { kind: "rejected", state }
  }

  return usernameMatches && message.userId === state.ownerUserId
    ? { kind: "owner", ownerPinned: false, state }
    : { kind: "rejected", state }
}

const rejectionOpenings = [
  "Go away",
  "Wrong operator",
  "Access denied",
  "Nice try, carbon unit",
] as const

const rejectionClosings = [
  "Go bother a smart fridge.",
  "Find a less loyal appliance.",
  "This bot has standards and an owner.",
  "The grill has more authority here than you do.",
] as const

export const freshClankerRejection = (counter: number): ClankerRejection => {
  const nextCounter = counter + 1
  const opening =
    rejectionOpenings[counter % rejectionOpenings.length] ??
    rejectionOpenings[0]
  const closingIndex = Math.floor(counter / rejectionOpenings.length) + counter
  const closing =
    rejectionClosings[closingIndex % rejectionClosings.length] ??
    rejectionClosings[0]
  return { text: `${opening}, I'm not your clanker. ${closing}`, nextCounter }
}

const decodeMessage = (
  input: Readonly<Record<string, unknown>>,
): Effect.Effect<TelegramMessage | undefined, TelegramContractError> => {
  const message = input.message
  if (message === undefined) return Effect.succeed(undefined)
  if (!isRecord(message)) {
    return Effect.fail(
      new TelegramContractError({
        message: "Telegram message must be an object",
      }),
    )
  }
  if (message.text === undefined) return Effect.succeed(undefined)
  if (typeof message.text !== "string" || !isSafeInteger(message.message_id)) {
    return Effect.fail(
      new TelegramContractError({
        message: "Telegram text message fields are invalid",
      }),
    )
  }
  if (
    !isRecord(message.from) ||
    !isSafeInteger(message.from.id) ||
    message.from.is_bot !== false
  ) {
    return Effect.fail(
      new TelegramContractError({
        message: "Telegram sender fields are invalid",
      }),
    )
  }
  if (
    message.from.username !== undefined &&
    typeof message.from.username !== "string"
  ) {
    return Effect.fail(
      new TelegramContractError({ message: "Telegram username is invalid" }),
    )
  }
  if (
    !isRecord(message.chat) ||
    !isSafeInteger(message.chat.id) ||
    message.chat.type !== "private"
  ) {
    return Effect.succeed(undefined)
  }

  const replyToMessage = message.reply_to_message
  if (
    replyToMessage !== undefined &&
    (!isRecord(replyToMessage) || !isSafeInteger(replyToMessage.message_id))
  ) {
    return Effect.fail(
      new TelegramContractError({
        message: "Telegram reply reference is invalid",
      }),
    )
  }

  return Effect.succeed({
    chatId: message.chat.id,
    messageId: message.message_id,
    userId: message.from.id,
    ...(message.from.username ? { username: message.from.username } : {}),
    text: message.text,
    ...(replyToMessage
      ? { replyToMessageId: replyToMessage.message_id as number }
      : {}),
  })
}

export const decodeTelegramSentMessageId = (
  input: unknown,
): Effect.Effect<number, TelegramContractError> => {
  if (
    !isRecord(input) ||
    input.ok !== true ||
    !isRecord(input.result) ||
    !isSafeInteger(input.result.message_id)
  ) {
    return Effect.fail(
      new TelegramContractError({
        message: "Telegram sendMessage response is invalid",
      }),
    )
  }

  return Effect.succeed(input.result.message_id)
}

export const decodeTelegramUpdates = (
  input: unknown,
): Effect.Effect<ReadonlyArray<TelegramUpdate>, TelegramContractError> => {
  if (!isRecord(input) || input.ok !== true || !Array.isArray(input.result)) {
    return Effect.fail(
      new TelegramContractError({
        message: "Telegram update envelope is invalid",
      }),
    )
  }

  return Effect.forEach(input.result, (update) => {
    if (!isRecord(update) || !isSafeInteger(update.update_id)) {
      return Effect.fail(
        new TelegramContractError({ message: "Telegram update id is invalid" }),
      )
    }
    return decodeMessage(update).pipe(
      Effect.map((message) =>
        message ? { updateId: update.update_id as number, message } : undefined,
      ),
    )
  }).pipe(
    Effect.map((updates) =>
      updates.filter(
        (update): update is TelegramUpdate => update !== undefined,
      ),
    ),
  )
}
