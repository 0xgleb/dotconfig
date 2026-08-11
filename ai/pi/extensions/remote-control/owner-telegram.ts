import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { Data, Effect } from "effect";
import { pieceOfPiStatePath } from "./paths.ts";
import { telegramHtmlChunks } from "./telegram-format.ts";
import { decodeTelegramSentMessageId } from "./telegram.ts";

const TELEGRAM_MESSAGE_LIMIT = 4_000;
const MAX_TELEGRAM_DESCRIPTION_CHARACTERS = 80;
const TOKEN_FILE_ENVIRONMENT = "PIECE_OF_PI_TELEGRAM_TOKEN_FILE";
/**
 * Only the launchd daemon exports TOKEN_FILE_ENVIRONMENT; interactive Pi
 * sessions never inherit it, so the relay lane falls back to the agenix
 * mount the daemon points at. The path is discovery only - reading the
 * token stays gated by the file's own 0400 owner permissions.
 */
const TOKEN_FILE_FALLBACK = "/run/agenix/metagenda-telegram-token";

/**
 * Every way this module can fail to put text in front of the owner. Each code
 * has a producer below; a code no path can produce would promise the caller a
 * distinction the module cannot actually make.
 */
export type OwnerRelayDeliveryCode =
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
 *
 * Secret handling boundary: this makes the Pi session a second holder of the
 * bot token, which until now lived only in the daemon. The token is read per
 * send, stays a value inside this pipeline, and never leaves it - it is not
 * stored, not logged, not put on a command line, and not named in any typed
 * failure. The request URL carries it, so no failure here ever quotes a URL;
 * failures name a code, an HTTP status, and Telegram's own description. What
 * the file permissions do not do is separate this session from the daemon:
 * both run as the same user, so the boundary is this module's own discipline
 * about where the value may travel.
 *
 * A report long enough to chunk is sent as several messages, and a rejection
 * partway through means the owner already has the earlier parts. The failure
 * says which part stopped and how many arrived, so the completion the owner
 * reads does not claim a wholly undelivered report.
 */
export const deliverOwnerRelay = (
  text: string,
): Effect.Effect<void, OwnerRelayDeliveryError> =>
  Effect.all({ token: telegramToken, chatId: ownerChatId }).pipe(
    Effect.flatMap(({ token, chatId }) => {
      const chunks = ownerRelayChunks(text);
      return Effect.forEach(
        chunks,
        (chunk, position) =>
          sendOwnerMessage(token, chatId, chunk).pipe(
            Effect.mapError((failure) =>
              chunks.length === 1
                ? failure
                : deliveryFailure(
                    failure.code,
                    `part ${position + 1} of ${chunks.length} failed, ${position} already delivered: ${failure.message}`,
                  ),
            ),
          ),
        { discard: true, concurrency: 1 },
      );
    }),
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

/**
 * A preview card is worth its space when a report points at one thing. A
 * report listing several PRs would otherwise get an unbidden expansion of
 * whichever link Telegram picked first, pushing the actual content off the
 * screen it was written to fit.
 */
export const hasMultipleLinks = (rendered: string): boolean =>
  (rendered.match(/<a href=/gu) ?? []).length > 1;

/**
 * The response stays a value in the pipeline rather than a variable captured
 * around it: this description is the only outward path to the owner, and a
 * status held in the closure would report the previous attempt's status the
 * moment anyone retries or reuses the built effect.
 */
const sendOwnerMessage = (
  token: string,
  chatId: number,
  text: string,
): Effect.Effect<void, OwnerRelayDeliveryError> =>
  Effect.tryPromise({
    try: () =>
      fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text,
          parse_mode: "HTML",
          ...(hasMultipleLinks(text)
            ? { link_preview_options: { is_disabled: true } }
            : {}),
        }),
      }),
    catch: () =>
      deliveryFailure(
        "send_failed",
        "the Telegram sendMessage request could not be sent",
      ),
  }).pipe(
    Effect.flatMap((response) =>
      response.ok
        ? Effect.tryPromise({
            try: () => response.json() as Promise<unknown>,
            catch: () =>
              deliveryFailure(
                "send_failed",
                "the Telegram sendMessage response was unreadable",
              ),
          })
        : Effect.flatMap(rejectionDetail(response), (detail) =>
            Effect.fail(
              deliveryFailure(
                "send_failed",
                `the Telegram sendMessage request returned status ${response.status}${detail}`,
              ),
            ),
          ),
    ),
    Effect.flatMap(decodeTelegramSentMessageId),
    Effect.catchTag("TelegramContractError", () =>
      Effect.fail(
        deliveryFailure(
          "send_failed",
          "the Telegram sendMessage response reported an error",
        ),
      ),
    ),
    Effect.asVoid,
  );

/**
 * Telegram answers a rejected send with a JSON envelope - `{ok: false,
 * error_code, description, parameters: {retry_after}}` - and answers 429 with
 * `parameters.retry_after` when one chat is sent to faster than roughly one
 * message a second, which is what a report long enough to chunk does. That
 * envelope is the only place the wait is stated, so it is decoded into the
 * failure the owner's completion carries rather than collapsed into a status
 * code nobody can act on.
 *
 * https://core.telegram.org/bots/api#making-requests
 *
 * A body that is not that envelope is not a second failure to report: the
 * status already names the rejection, so the detail is simply empty.
 */
const rejectionDetail = (response: Response): Effect.Effect<string> =>
  Effect.tryPromise({
    try: () => response.json() as Promise<unknown>,
    catch: () =>
      deliveryFailure("send_failed", "the rejection body was unreadable"),
  }).pipe(
    Effect.map(describedRejection),
    Effect.orElseSucceed(() => ""),
  );

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const describedRejection = (envelope: unknown): string => {
  if (!isRecord(envelope)) return "";
  const parameters = isRecord(envelope.parameters)
    ? envelope.parameters
    : undefined;
  const retryAfter = parameters?.retry_after;
  const detail = [
    ...(typeof envelope.description === "string" && envelope.description
      ? [envelope.description.slice(0, MAX_TELEGRAM_DESCRIPTION_CHARACTERS)]
      : []),
    ...(typeof retryAfter === "number" && Number.isSafeInteger(retryAfter)
      ? [`retry after ${retryAfter}s`]
      : []),
  ].join("; ");
  return detail ? `: ${detail}` : "";
};
