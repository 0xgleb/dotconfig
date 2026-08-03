import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { Data, Effect } from "effect";
import { pieceOfPiStatePath } from "./paths.ts";
import { telegramHtmlChunks } from "./telegram-format.ts";
import { decodeTelegramSentMessageId } from "./telegram.ts";

const TELEGRAM_MESSAGE_LIMIT = 4_000;
const TOKEN_FILE_ENVIRONMENT = "PIECE_OF_PI_TELEGRAM_TOKEN_FILE";
/**
 * Only the launchd daemon exports TOKEN_FILE_ENVIRONMENT; interactive Pi
 * sessions never inherit it, so the relay lane falls back to the agenix
 * mount the daemon points at. The path is discovery only - reading the
 * token stays gated by the file's own 0400 owner permissions.
 */
const TOKEN_FILE_FALLBACK = "/run/agenix/metagenda-telegram-token";

export type OwnerRelayDeliveryCode =
  | "transport_unconfigured"
  | "token_unreadable"
  | "token_invalid"
  | "owner_chat_unknown"
  | "send_failed";

export class OwnerRelayDeliveryError extends Data.TaggedError(
  "OwnerRelayDeliveryError",
)<{
  readonly code: OwnerRelayDeliveryCode;
  readonly message: string;
}> {}

/**
 * Bridge completions only reach Telegram for messages that originated there,
 * so an outward owner relay has to be sent by whoever intercepts it. The Piece
 * of Pi daemon is a separate process and exposes no callable surface: the only
 * shared state is the token file named by TOKEN_FILE_ENVIRONMENT and the owner
 * chat recorded in the daemon state file. Every reason this cannot send is a
 * typed failure so the caller can report it instead of claiming delivery.
 */
export const deliverOwnerRelay = (
  text: string,
): Effect.Effect<void, OwnerRelayDeliveryError> =>
  Effect.all({ token: telegramToken, chatId: ownerChatId }).pipe(
    Effect.flatMap(({ token, chatId }) =>
      Effect.forEach(
        ownerRelayChunks(text),
        (chunk) => sendOwnerMessage(token, chatId, chunk),
        { discard: true, concurrency: 1 },
      ),
    ),
  );

const deliveryFailure = (
  code: OwnerRelayDeliveryCode,
  message: string,
): OwnerRelayDeliveryError => new OwnerRelayDeliveryError({ code, message });

const telegramToken: Effect.Effect<string, OwnerRelayDeliveryError> =
  Effect.suspend(() => {
    const tokenFile =
      process.env[TOKEN_FILE_ENVIRONMENT]?.trim() || TOKEN_FILE_FALLBACK;
    return Effect.tryPromise({
      try: () =>
        readFile(tokenFile, "utf8").then((contents) => contents.trim()),
      catch: () =>
        deliveryFailure(
          "token_unreadable",
          `the file named by ${TOKEN_FILE_ENVIRONMENT} could not be read`,
        ),
    }).pipe(
      Effect.flatMap((token) =>
        /^\d+:[A-Za-z0-9_-]+$/.test(token)
          ? Effect.succeed(token)
          : Effect.fail(
              deliveryFailure(
                "token_invalid",
                "the Telegram bot token has an invalid shape",
              ),
            ),
      ),
    );
  });

const ownerChatId: Effect.Effect<number, OwnerRelayDeliveryError> =
  Effect.suspend(() =>
    Effect.tryPromise({
      try: () =>
        readFile(
          pieceOfPiStatePath(process.env.XDG_STATE_HOME, homedir()),
          "utf8",
        ),
      catch: () =>
        deliveryFailure(
          "owner_chat_unknown",
          "the Piece of Pi state file could not be read",
        ),
    }).pipe(
      Effect.flatMap((contents) =>
        Effect.try({
          try: () => JSON.parse(contents) as unknown,
          catch: () =>
            deliveryFailure(
              "owner_chat_unknown",
              "the Piece of Pi state file is not valid JSON",
            ),
        }),
      ),
      Effect.flatMap((state) => {
        const chatId =
          typeof state === "object" && state !== null && !Array.isArray(state)
            ? (state as Readonly<Record<string, unknown>>).ownerChatId
            : undefined;
        return typeof chatId === "number" && Number.isSafeInteger(chatId)
          ? Effect.succeed(chatId)
          : Effect.fail(
              deliveryFailure(
                "owner_chat_unknown",
                "the owner has not opened a Piece of Pi chat yet",
              ),
            );
      }),
    ),
  );

/**
 * Relayed reports are the owner's primary view of what the fleet did, and they
 * arrive as dense prose when the transport cannot render structure. The
 * command lane already renders a markdown subset into Telegram HTML; the relay
 * lane is what agents actually report through, so it renders the same way.
 * Splitting on rendered units also stops a blind character slice from cutting
 * a tag in half and failing the send.
 */
export const ownerRelayChunks = (text: string): readonly string[] =>
  telegramHtmlChunks(text, TELEGRAM_MESSAGE_LIMIT);

const sendOwnerMessage = (
  token: string,
  chatId: number,
  text: string,
): Effect.Effect<void, OwnerRelayDeliveryError> => {
  let status: number | undefined;
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
          }),
        },
      );
      status = response.status;
      if (!response.ok) throw new Error("Telegram HTTP request failed");
      return (await response.json()) as unknown;
    },
    catch: () =>
      deliveryFailure(
        "send_failed",
        `the Telegram sendMessage request failed${status === undefined ? "" : ` with status ${status}`}`,
      ),
  }).pipe(
    Effect.flatMap(decodeTelegramSentMessageId),
    Effect.mapError((error) =>
      error instanceof OwnerRelayDeliveryError
        ? error
        : deliveryFailure(
            "send_failed",
            "the Telegram sendMessage response reported an error",
          ),
    ),
    Effect.asVoid,
  );
};
