import { readFile, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { Data, Effect } from "effect"
import {
  decodeChatRegistry,
  knownChatNames,
  resolveChat,
  type ChatRegistry,
} from "./chat-registry.ts"
import { pieceOfPiStatePath } from "./paths.ts"
import { telegramHtmlChunks } from "./telegram-format.ts"
import { cabaSessionCard, initialCabaSession } from "./caba-tracker.ts"
import { decodeTelegramSentMessageId } from "./telegram.ts"

const TELEGRAM_MESSAGE_LIMIT = 4_000
export const MAX_OWNER_REPORT_CHARACTERS = 16_000
const MAX_REPORT_SENDER_CHARACTERS = 160
const TOKEN_FILE_ENVIRONMENT = "PIECE_OF_PI_TELEGRAM_TOKEN_FILE"
/**
 * Only the launchd daemon exports TOKEN_FILE_ENVIRONMENT; interactive Pi
 * sessions never inherit it, so the relay lane falls back to the agenix
 * mount the daemon points at. The path is discovery only - reading the
 * token stays gated by the file's own 0400 owner permissions.
 */
const TOKEN_FILE_FALLBACK = "/run/agenix/metagenda-telegram-token"

export type OwnerRelayDeliveryCode =
  | "transport_unconfigured"
  | "token_unreadable"
  | "token_invalid"
  | "owner_chat_unknown"
  | "chat_registry_unreadable"
  | "send_failed"

export class OwnerRelayDeliveryError extends Data.TaggedError(
  "OwnerRelayDeliveryError",
)<{
  readonly code: OwnerRelayDeliveryCode
  readonly message: string
}> {}

/**
 * Bridge completions only reach Telegram for messages that originated there,
 * so an outward owner relay has to be sent by whoever intercepts it. The Piece
 * of Pi daemon is a separate process and exposes no callable surface: the only
 * shared state is the token file named by TOKEN_FILE_ENVIRONMENT and the owner
 * chat recorded in the daemon state file. Every reason this cannot send is a
 * typed failure so the caller can report it instead of claiming delivery.
 */
export const agentReportText = (text: string, sender: string): string => {
  const safeSender =
    sender
      .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}`<>]/gu, " ")
      .replace(/\s+/gu, " ")
      .trim()
      .slice(0, MAX_REPORT_SENDER_CHARACTERS) || "unknown-agent"
  return `**Agent report** · \`${safeSender}\` · direct via Piece of Pi\n\n${text}`
}

export const cabaCardRelayPayload = (
  now: number,
): ReturnType<typeof cabaSessionCard> =>
  cabaSessionCard(initialCabaSession(now), now)

export const deliverCabaCardRelay = (): Effect.Effect<
  void,
  OwnerRelayDeliveryError
> =>
  Effect.all({
    token: telegramToken,
    state: pieceOfPiState("owner_chat_unknown"),
  }).pipe(
    Effect.flatMap(({ token, state }) => {
      const chatId = stateField(state, "ownerChatId")
      if (typeof chatId !== "number" || !Number.isSafeInteger(chatId))
        return Effect.fail(
          deliveryFailure(
            "owner_chat_unknown",
            "the owner has not opened a Piece of Pi chat yet",
          ),
        )
      const startedAt = Date.now()
      const session = initialCabaSession(startedAt)
      const card = cabaSessionCard(session, startedAt)
      return sendOwnerMessage(token, chatId, card.text, card.replyMarkup).pipe(
        Effect.flatMap(messageId =>
          persistCabaRelayState(state, { ...session, messageId }),
        ),
      )
    }),
  )

export const deliverOwnerRelay = (
  text: string,
  sender: string,
): Effect.Effect<void, OwnerRelayDeliveryError> =>
  Effect.all({ token: telegramToken, chatId: ownerChatId }).pipe(
    Effect.flatMap(({ token, chatId }) =>
      sendRelay(token, chatId, agentReportText(text, sender)),
    ),
  )

/**
 * Stakeholder updates are authored for the owner to forward unchanged, so the
 * visible Telegram message must not carry the agent-status provenance banner.
 * This is deliberately a separate typed delivery lane rather than a flag on
 * deliverOwnerRelay: ordinary reports can never accidentally downgrade their
 * visible provenance. Sender, timestamp, and size are retained by the caller's
 * private audit entry without retaining the stakeholder message body there.
 */
export const stakeholderUpdateText = (text: string): string => text

export const deliverStakeholderUpdate = (
  text: string,
): Effect.Effect<void, OwnerRelayDeliveryError> =>
  Effect.all({ token: telegramToken, chatId: ownerChatId }).pipe(
    Effect.flatMap(({ token, chatId }) =>
      sendRelay(token, chatId, stakeholderUpdateText(text)),
    ),
  )

export type ChatRelayDispatch =
  | { readonly outcome: "delivered"; readonly title: string }
  | { readonly outcome: "unknown_chat"; readonly known: readonly string[] }

/**
 * Naming a chat the registry has never seen is an expected state, not a
 * transport fault: it means the owner has not spoken in that group yet. It
 * comes back as a dispatch outcome carrying the names that would have worked,
 * while only the transport itself fails the effect.
 */
export const deliverChatRelay = (
  name: string,
  text: string,
): Effect.Effect<ChatRelayDispatch, OwnerRelayDeliveryError> =>
  chatRegistry.pipe(
    Effect.flatMap(chats => {
      const chat = resolveChat(chats, name)
      if (!chat) {
        return Effect.succeed({
          outcome: "unknown_chat",
          known: knownChatNames(chats),
        } satisfies ChatRelayDispatch)
      }
      return telegramToken.pipe(
        Effect.flatMap(token => sendRelay(token, chat.id, text)),
        Effect.as({
          outcome: "delivered",
          title: chat.title,
        } satisfies ChatRelayDispatch),
      )
    }),
  )

const sendRelay = (
  token: string,
  chatId: number,
  text: string,
): Effect.Effect<void, OwnerRelayDeliveryError> =>
  Effect.forEach(
    ownerRelayChunks(text),
    chunk => sendOwnerMessage(token, chatId, chunk),
    { discard: true, concurrency: 1 },
  ).pipe(Effect.asVoid)

const deliveryFailure = (
  code: OwnerRelayDeliveryCode,
  message: string,
): OwnerRelayDeliveryError => new OwnerRelayDeliveryError({ code, message })

const telegramToken: Effect.Effect<string, OwnerRelayDeliveryError> =
  Effect.suspend(() => {
    const tokenFile =
      process.env[TOKEN_FILE_ENVIRONMENT]?.trim() || TOKEN_FILE_FALLBACK
    return Effect.tryPromise({
      try: () => readFile(tokenFile, "utf8").then(contents => contents.trim()),
      catch: () =>
        deliveryFailure(
          "token_unreadable",
          `the file named by ${TOKEN_FILE_ENVIRONMENT} could not be read`,
        ),
    }).pipe(
      Effect.flatMap(token =>
        /^\d+:[A-Za-z0-9_-]+$/.test(token)
          ? Effect.succeed(token)
          : Effect.fail(
              deliveryFailure(
                "token_invalid",
                "the Telegram bot token has an invalid shape",
              ),
            ),
      ),
    )
  })

const pieceOfPiState = (
  code: OwnerRelayDeliveryCode,
): Effect.Effect<unknown, OwnerRelayDeliveryError> =>
  Effect.suspend(() =>
    Effect.tryPromise({
      try: () =>
        readFile(
          pieceOfPiStatePath(process.env.XDG_STATE_HOME, homedir()),
          "utf8",
        ),
      catch: () =>
        deliveryFailure(code, "the Piece of Pi state file could not be read"),
    }).pipe(
      Effect.flatMap(contents =>
        Effect.try({
          try: () => JSON.parse(contents) as unknown,
          catch: () =>
            deliveryFailure(
              code,
              "the Piece of Pi state file is not valid JSON",
            ),
        }),
      ),
    ),
  )

const stateField = (state: unknown, field: string): unknown =>
  typeof state === "object" && state !== null && !Array.isArray(state)
    ? (state as Readonly<Record<string, unknown>>)[field]
    : undefined

const persistCabaRelayState = (
  state: unknown,
  cabaSession: ReturnType<typeof initialCabaSession> & {
    readonly messageId: number
  },
): Effect.Effect<void, OwnerRelayDeliveryError> => {
  if (typeof state !== "object" || state === null || Array.isArray(state))
    return Effect.fail(
      deliveryFailure(
        "owner_chat_unknown",
        "the Piece of Pi state is malformed",
      ),
    )
  return Effect.tryPromise({
    try: () =>
      writeFile(
        pieceOfPiStatePath(process.env.XDG_STATE_HOME, homedir()),
        `${JSON.stringify({ ...state, cabaSession })}\n`,
        { encoding: "utf8", mode: 0o600 },
      ),
    catch: () =>
      deliveryFailure(
        "send_failed",
        "the tracker was sent but its active state could not be persisted",
      ),
  })
}

const ownerChatId: Effect.Effect<number, OwnerRelayDeliveryError> =
  pieceOfPiState("owner_chat_unknown").pipe(
    Effect.flatMap(state => {
      const chatId = stateField(state, "ownerChatId")
      return typeof chatId === "number" && Number.isSafeInteger(chatId)
        ? Effect.succeed(chatId)
        : Effect.fail(
            deliveryFailure(
              "owner_chat_unknown",
              "the owner has not opened a Piece of Pi chat yet",
            ),
          )
    }),
  )

const chatRegistry: Effect.Effect<ChatRegistry, OwnerRelayDeliveryError> =
  pieceOfPiState("chat_registry_unreadable").pipe(
    Effect.map(state => decodeChatRegistry(stateField(state, "chats"))),
  )

/**
 * Relayed reports are the owner's primary view of what the fleet did, and they
 * arrive as dense prose when the transport cannot render structure. The
 * command lane already renders a markdown subset into Telegram HTML; the relay
 * lane is what agents actually report through, so it renders the same way.
 * Splitting on rendered units also stops a blind character slice from cutting
 * a tag in half and failing the send.
 */
export const ownerRelayChunks = (text: string): readonly string[] =>
  telegramHtmlChunks(text, TELEGRAM_MESSAGE_LIMIT)

/**
 * A preview card is worth its space when a report points at one thing. A
 * report listing several PRs would otherwise get an unbidden expansion of
 * whichever link Telegram picked first, pushing the actual content off the
 * screen it was written to fit.
 */
export const hasMultipleLinks = (rendered: string): boolean =>
  (rendered.match(/<a href=/gu) ?? []).length > 1

const sendOwnerMessage = (
  token: string,
  chatId: number,
  text: string,
  replyMarkup?: ReturnType<typeof cabaSessionCard>["replyMarkup"],
): Effect.Effect<number, OwnerRelayDeliveryError> => {
  let status: number | undefined
  return Effect.tryPromise({
    try: async () => {
      const response = await fetch(
        `https://api.telegram.org/bot${token}/sendMessage`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            chat_id: chatId,
            text,
            parse_mode: "HTML",
            ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
            ...(hasMultipleLinks(text)
              ? { link_preview_options: { is_disabled: true } }
              : {}),
          }),
        },
      )
      status = response.status
      if (!response.ok) throw new Error("Telegram HTTP request failed")
      return (await response.json()) as unknown
    },
    catch: () =>
      deliveryFailure(
        "send_failed",
        `the Telegram sendMessage request failed${status === undefined ? "" : ` with status ${status}`}`,
      ),
  }).pipe(
    Effect.flatMap(decodeTelegramSentMessageId),
    Effect.mapError(error =>
      error instanceof OwnerRelayDeliveryError
        ? error
        : deliveryFailure(
            "send_failed",
            "the Telegram sendMessage response reported an error",
          ),
    ),
  )
}
