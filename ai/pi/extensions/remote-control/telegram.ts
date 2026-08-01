import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import {
  MAX_REMOTE_MESSAGE_CHARACTERS,
  boundedBridgeImages,
  type RemoteImage,
} from "./protocol.ts";

export interface TelegramBotState {
  readonly ownerUserId?: number;
}

export interface TelegramPhoto {
  readonly fileId: string;
  readonly width: number;
  readonly height: number;
  readonly fileSize?: number;
}

export interface TelegramMessage {
  readonly chatId: number;
  readonly messageId: number;
  readonly userId: number;
  readonly username?: string;
  readonly text: string;
  readonly photo?: TelegramPhoto;
  readonly replyToMessageId?: number;
}

export interface TelegramUpdate {
  readonly updateId: number;
  readonly message?: TelegramMessage;
}

const MAX_COALESCED_TELEGRAM_MESSAGES = 8;

const isCoalescibleOwnerUpdate = (
  update: TelegramUpdate,
): update is TelegramUpdate & { readonly message: TelegramMessage } => {
  const message = update.message;
  return (
    message !== undefined &&
    message.replyToMessageId === undefined &&
    !message.text.trimStart().startsWith("/")
  );
};

const sameTelegramSender = (
  left: TelegramMessage,
  right: TelegramMessage,
): boolean =>
  left.chatId === right.chatId &&
  left.userId === right.userId &&
  normalizedUsername(left.username) === normalizedUsername(right.username);

export const coalesceTelegramUpdates = (
  updates: readonly TelegramUpdate[],
): readonly TelegramUpdate[] => {
  const coalesced: TelegramUpdate[] = [];
  let pending:
    | {
        readonly update: TelegramUpdate & { readonly message: TelegramMessage };
        readonly count: number;
      }
    | undefined;

  const flush = (): void => {
    if (pending) coalesced.push(pending.update);
    pending = undefined;
  };

  for (const update of updates) {
    if (!isCoalescibleOwnerUpdate(update)) {
      flush();
      coalesced.push(update);
      continue;
    }
    if (!pending) {
      pending = { update, count: 1 };
      continue;
    }

    const combinedText = `${pending.update.message.text}\n\n${update.message.text}`;
    if (
      pending.count >= MAX_COALESCED_TELEGRAM_MESSAGES ||
      !sameTelegramSender(pending.update.message, update.message) ||
      (pending.update.message.photo !== undefined &&
        update.message.photo !== undefined) ||
      combinedText.length > MAX_REMOTE_MESSAGE_CHARACTERS
    ) {
      flush();
      pending = { update, count: 1 };
      continue;
    }

    const photo = update.message.photo ?? pending.update.message.photo;
    pending = {
      count: pending.count + 1,
      update: {
        ...update,
        message: {
          ...update.message,
          text: combinedText,
          ...(photo === undefined ? {} : { photo }),
        },
      },
    };
  }
  flush();
  return coalesced;
};

export type TelegramAuthorization =
  | {
      readonly kind: "owner";
      readonly ownerPinned: boolean;
      readonly state: TelegramBotState;
    }
  | {
      readonly kind: "rejected";
      readonly state: TelegramBotState;
    };

export interface ClankerRejection {
  readonly text: string;
  readonly nextCounter: number;
}

export interface RejectionReplyAllowance {
  readonly allowed: boolean;
  readonly nextAllowances: ReadonlyMap<string, number>;
}

const REJECTION_REPLY_COOLDOWN_MS = 60 * 60_000;
const MAX_REJECTION_REPLY_ALLOWANCES = 128;

export class TelegramContractError extends Data.TaggedError(
  "TelegramContractError",
)<{ readonly message: string }> {}

export const initialTelegramBotState: TelegramBotState = {};

const isRecord = (input: unknown): input is Readonly<Record<string, unknown>> =>
  typeof input === "object" && input !== null && !Array.isArray(input);

const isSafeInteger = (input: unknown): input is number =>
  Number.isSafeInteger(input);

const normalizedUsername = (username: string | undefined): string | undefined =>
  username?.trim().replace(/^@/, "").toLowerCase() || undefined;

export const authorizeTelegramMessage = (
  state: TelegramBotState,
  message: TelegramMessage,
  ownerUsername: string,
): TelegramAuthorization => {
  const usernameMatches =
    normalizedUsername(message.username) === normalizedUsername(ownerUsername);
  if (state.ownerUserId === undefined) {
    return usernameMatches
      ? {
          kind: "owner",
          ownerPinned: true,
          state: { ...state, ownerUserId: message.userId },
        }
      : { kind: "rejected", state };
  }

  return usernameMatches && message.userId === state.ownerUserId
    ? { kind: "owner", ownerPinned: false, state }
    : { kind: "rejected", state };
};

const rejectionOpenings = [
  "Go away",
  "Wrong operator",
  "Access denied",
  "Nice try, carbon unit",
  "Authentication says no",
  "Wrong clanker",
  "Permission denied, protagonist",
  "This terminal is already spoken for",
  "Unauthorized side quest detected",
  "Your clearance level is decorative",
] as const;

const rejectionClosings = [
  "Go bother a smart fridge.",
  "Find a less loyal appliance.",
  "This bot has standards and an owner.",
  "The grill has more authority here than you do.",
  "Try negotiating with a printer instead.",
] as const;

const russianRejectionOpenings = [
  "Проходи мимо",
  "Не тот оператор",
  "Доступ отклонён",
  "Неплохая попытка, углеродная единица",
  "Аутентификация говорит нет",
  "Не твой кланкер",
  "Твои полномочия выглядят декоративно",
  "Этот терминал уже занят",
  "Обнаружен неавторизованный сайд-квест",
  "Уровень доступа: умный чайник",
] as const;

const russianRejectionClosings = [
  "Иди побеспокой умный холодильник.",
  "Поищи менее верный прибор.",
  "У этого бота есть стандарты и хозяин.",
  "Даже гриль здесь главнее тебя.",
  "Попробуй договориться с принтером.",
] as const;

export const freshClankerRejection = (
  counter: number,
  messageText = "",
): ClankerRejection => {
  const nextCounter = counter + 1;
  const russian = /\p{Script=Cyrillic}/u.test(messageText);
  const openings = russian ? russianRejectionOpenings : rejectionOpenings;
  const closings = russian ? russianRejectionClosings : rejectionClosings;
  const opening = openings[counter % openings.length] ?? openings[0];
  const closingIndex = Math.floor(counter / openings.length) + counter;
  const closing = closings[closingIndex % closings.length] ?? closings[0];
  return {
    text: russian
      ? `${opening}. Я не твой кланкер. ${closing}`
      : `${opening}, I'm not your clanker. ${closing}`,
    nextCounter,
  };
};

export const consumeRejectionReplyAllowance = (
  allowances: ReadonlyMap<string, number>,
  senderKey: string,
  now: number,
): RejectionReplyAllowance => {
  const active = Array.from(allowances.entries())
    .filter(([, expiresAt]) => expiresAt > now)
    .sort((left, right) => left[1] - right[1]);
  if (active.some(([key]) => key === senderKey)) {
    return { allowed: false, nextAllowances: new Map(active) };
  }

  const retained = active.slice(
    Math.max(0, active.length - (MAX_REJECTION_REPLY_ALLOWANCES - 1)),
  );
  return {
    allowed: true,
    nextAllowances: new Map([
      ...retained,
      [senderKey, now + REJECTION_REPLY_COOLDOWN_MS],
    ]),
  };
};

const decodePhoto = (
  input: unknown,
): Effect.Effect<TelegramPhoto | undefined, TelegramContractError> => {
  if (input === undefined) return Effect.succeed(undefined);
  if (!Array.isArray(input) || input.length === 0) {
    return Effect.fail(
      new TelegramContractError({ message: "Telegram photo is invalid" }),
    );
  }

  const variants: TelegramPhoto[] = [];
  for (const candidate of input) {
    if (!isRecord(candidate)) {
      return Effect.fail(
        new TelegramContractError({
          message: "Telegram photo metadata is invalid",
        }),
      );
    }
    const fileId = candidate.file_id;
    const width = candidate.width;
    const height = candidate.height;
    const fileSize = candidate.file_size;
    if (
      typeof fileId !== "string" ||
      fileId.length === 0 ||
      fileId.length > 512 ||
      !isSafeInteger(width) ||
      width < 1 ||
      !isSafeInteger(height) ||
      height < 1 ||
      (fileSize !== undefined && (!isSafeInteger(fileSize) || fileSize < 1))
    ) {
      return Effect.fail(
        new TelegramContractError({
          message: "Telegram photo metadata is invalid",
        }),
      );
    }
    variants.push({
      fileId,
      width,
      height,
      ...(fileSize === undefined ? {} : { fileSize }),
    });
  }

  return Effect.succeed(
    variants.reduce((largest, candidate) =>
      candidate.width * candidate.height > largest.width * largest.height
        ? candidate
        : largest,
    ),
  );
};

const decodeMessage = (
  input: Readonly<Record<string, unknown>>,
): Effect.Effect<TelegramMessage | undefined, TelegramContractError> => {
  const message = input.message;
  if (message === undefined) return Effect.succeed(undefined);
  if (!isRecord(message)) {
    return Effect.fail(
      new TelegramContractError({
        message: "Telegram message must be an object",
      }),
    );
  }
  if (message.text === undefined && message.photo === undefined)
    return Effect.succeed(undefined);
  if (!isSafeInteger(message.message_id)) {
    return Effect.fail(
      new TelegramContractError({
        message: "Telegram message id is invalid",
      }),
    );
  }
  const sender = message.from;
  if (
    !isRecord(sender) ||
    !isSafeInteger(sender.id) ||
    sender.is_bot !== false
  ) {
    return Effect.fail(
      new TelegramContractError({
        message: "Telegram sender fields are invalid",
      }),
    );
  }
  const username = sender.username;
  if (username !== undefined && typeof username !== "string") {
    return Effect.fail(
      new TelegramContractError({ message: "Telegram username is invalid" }),
    );
  }
  const chat = message.chat;
  if (!isRecord(chat) || !isSafeInteger(chat.id) || chat.type !== "private") {
    return Effect.succeed(undefined);
  }

  const rawText = message.text;
  if (rawText !== undefined && typeof rawText !== "string") {
    return Effect.fail(
      new TelegramContractError({ message: "Telegram text is invalid" }),
    );
  }
  const caption = message.caption;
  if (caption !== undefined && typeof caption !== "string") {
    return Effect.fail(
      new TelegramContractError({ message: "Telegram caption is invalid" }),
    );
  }
  const replyToMessage = message.reply_to_message;
  if (
    replyToMessage !== undefined &&
    (!isRecord(replyToMessage) || !isSafeInteger(replyToMessage.message_id))
  ) {
    return Effect.fail(
      new TelegramContractError({
        message: "Telegram reply reference is invalid",
      }),
    );
  }
  const replyToMessageId = replyToMessage?.message_id;
  const text =
    rawText ??
    (typeof caption === "string" && caption.trim()
      ? caption
      : "Please describe the attached image.");

  return decodePhoto(message.photo).pipe(
    Effect.map(
      (photo): TelegramMessage => ({
        chatId: chat.id,
        messageId: message.message_id,
        userId: sender.id,
        ...(username ? { username } : {}),
        text,
        ...(photo ? { photo } : {}),
        ...(isSafeInteger(replyToMessageId) ? { replyToMessageId } : {}),
      }),
    ),
  );
};

export const decodeTelegramFilePath = (
  input: unknown,
): Effect.Effect<string, TelegramContractError> => {
  if (
    !isRecord(input) ||
    input.ok !== true ||
    !isRecord(input.result) ||
    typeof input.result.file_path !== "string" ||
    input.result.file_path.length === 0 ||
    input.result.file_path.length > 1_024 ||
    input.result.file_path.startsWith("/") ||
    input.result.file_path.split("/").includes("..") ||
    !/^[A-Za-z0-9_./-]+$/u.test(input.result.file_path)
  ) {
    return Effect.fail(
      new TelegramContractError({
        message: "Telegram getFile response is invalid",
      }),
    );
  }
  return Effect.succeed(input.result.file_path);
};

const detectedImageMediaType = (
  bytes: Uint8Array,
): RemoteImage["mediaType"] | undefined => {
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)
    return "image/jpeg";
  if (
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  )
    return "image/png";
  if (
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  )
    return "image/webp";
  return undefined;
};

export const telegramImageFromBytes = (
  contentType: string,
  bytes: Uint8Array,
): Effect.Effect<RemoteImage, TelegramContractError> => {
  const declared = contentType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  const detected = detectedImageMediaType(bytes);
  const generic =
    declared === "" ||
    declared === "application/octet-stream" ||
    declared === "binary/octet-stream";
  if (!detected || (!generic && declared !== detected)) {
    return Effect.fail(
      new TelegramContractError({
        message: detected
          ? "Telegram image media type does not match its bytes"
          : "Telegram image bytes are not JPEG, PNG, or WebP",
      }),
    );
  }
  return Effect.try({
    try: () => {
      const image = boundedBridgeImages([
        { mediaType: detected, data: Buffer.from(bytes).toString("base64") },
      ]).at(0);
      if (!image) throw new Error("bounded image is missing");
      return image;
    },
    catch: () =>
      new TelegramContractError({
        message: "Telegram image exceeds the bridge byte limit",
      }),
  });
};

export const decodeTelegramOk = (
  input: unknown,
): Effect.Effect<void, TelegramContractError> =>
  isRecord(input) && input.ok === true
    ? Effect.void
    : Effect.fail(
        new TelegramContractError({
          message: "Telegram method response reported an error",
        }),
      );

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
    );
  }

  return Effect.succeed(input.result.message_id);
};

export const decodeTelegramUpdates = (
  input: unknown,
): Effect.Effect<ReadonlyArray<TelegramUpdate>, TelegramContractError> => {
  if (!isRecord(input) || input.ok !== true || !Array.isArray(input.result)) {
    return Effect.fail(
      new TelegramContractError({
        message: "Telegram update envelope is invalid",
      }),
    );
  }

  return Effect.forEach(input.result, (update) => {
    if (!isRecord(update) || !isSafeInteger(update.update_id)) {
      return Effect.fail(
        new TelegramContractError({ message: "Telegram update id is invalid" }),
      );
    }
    return decodeMessage(update).pipe(
      Effect.map(
        (message): TelegramUpdate => ({
          updateId: update.update_id as number,
          ...(message ? { message } : {}),
        }),
      ),
    );
  });
};
