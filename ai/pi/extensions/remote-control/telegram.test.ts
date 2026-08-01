import assert from "node:assert/strict";
import test from "node:test";
import * as Effect from "effect/Effect";
import * as Either from "effect/Either";

import {
  authorizeTelegramMessage,
  coalesceTelegramUpdates,
  consumeRejectionReplyAllowance,
  decodeTelegramFilePath,
  decodeTelegramOk,
  decodeTelegramSentMessageId,
  decodeTelegramUpdates,
  telegramAcknowledgementReaction,
  telegramImageFromBytes,
  freshClankerRejection,
  initialTelegramBotState,
} from "./telegram.ts";

const ownerMessage = {
  chatId: 42,
  messageId: 7,
  userId: 1001,
  username: "dianov",
  text: "yo",
};

test("the first @dianov message pins the immutable owner user id", () => {
  const authorization = authorizeTelegramMessage(
    initialTelegramBotState,
    ownerMessage,
    "dianov",
  );

  assert.equal(authorization.kind, "owner");
  assert.equal(authorization.ownerPinned, true);
  assert.equal(authorization.state.ownerUserId, 1001);
});

test("owner authorization requires both the pinned id and current username", () => {
  const pinned = { ...initialTelegramBotState, ownerUserId: 1001 };
  const wrongId = authorizeTelegramMessage(
    pinned,
    { ...ownerMessage, userId: 9999 },
    "dianov",
  );
  const missingUsername = authorizeTelegramMessage(
    pinned,
    { ...ownerMessage, username: undefined },
    "dianov",
  );

  assert.equal(wrongId.kind, "rejected");
  assert.equal(missingUsername.kind, "rejected");
  assert.deepEqual(wrongId.state, pinned);
  assert.deepEqual(missingUsername.state, pinned);
});

test("unauthorized senders never alter owner state and receive local clanker rejections", () => {
  const stranger = { ...ownerMessage, userId: 2002, username: "stranger" };
  const authorization = authorizeTelegramMessage(
    initialTelegramBotState,
    stranger,
    "dianov",
  );
  const first = freshClankerRejection(0);
  const second = freshClankerRejection(first.nextCounter);

  assert.equal(authorization.kind, "rejected");
  assert.deepEqual(authorization.state, initialTelegramBotState);
  const russian = freshClankerRejection(0, "Привет, кланкер");

  assert.notEqual(first.text, second.text);
  assert.match(first.text, /not your clanker/i);
  assert.match(second.text, /not your clanker/i);
  assert.match(russian.text, /[А-Яа-яЁё]/u);
});

test("local clanker pools compose fifty unique replies per supported language", () => {
  const english = Array.from({ length: 50 }, (_, counter) =>
    freshClankerRejection(counter).text,
  );
  const russian = Array.from({ length: 50 }, (_, counter) =>
    freshClankerRejection(counter, "Привет").text,
  );

  assert.equal(new Set(english).size, 50);
  assert.equal(new Set(russian).size, 50);
  assert.equal(russian.every((text) => /[А-Яа-яЁё]/u.test(text)), true);
});

test("unauthorized rejection replies are bounded per sender without persisted identifiers", () => {
  const first = consumeRejectionReplyAllowance(new Map(), "2002:42", 1_000);
  const repeated = consumeRejectionReplyAllowance(
    first.nextAllowances,
    "2002:42",
    1_001,
  );
  const otherSender = consumeRejectionReplyAllowance(
    repeated.nextAllowances,
    "3003:42",
    1_002,
  );
  const afterCooldown = consumeRejectionReplyAllowance(
    otherSender.nextAllowances,
    "2002:42",
    3_601_001,
  );

  assert.equal(first.allowed, true);
  assert.equal(repeated.allowed, false);
  assert.equal(otherSender.allowed, true);
  assert.equal(afterCooldown.allowed, true);
  assert.equal(afterCooldown.nextAllowances.size <= 128, true);
});

test("owner acknowledgements vary locally by context without model calls", () => {
  const question = telegramAcknowledgementReaction(
    { ...ownerMessage, text: "Can you review this?" },
    1,
  );
  const image = telegramAcknowledgementReaction(
    {
      ...ownerMessage,
      text: "look at this",
      photo: { fileId: "screen", width: 100, height: 100 },
    },
    2,
  );
  const failures = new Set(
    Array.from({ length: 20 }, (_, updateId) =>
      telegramAcknowledgementReaction(
        { ...ownerMessage, text: "this error bricked the worker" },
        updateId,
      ),
    ),
  );

  assert.match(question, /^(?:🤔|👀)$/u);
  assert.match(image, /^(?:👀|🤓)$/u);
  assert.equal(failures.size > 1, true);
  assert.equal(
    telegramAcknowledgementReaction(ownerMessage, 7),
    telegramAcknowledgementReaction(ownerMessage, 7),
  );
});

test("Telegram updates decode only documented private text-message fields", async () => {
  const decoded = await Effect.runPromise(
    Effect.either(
      decodeTelegramUpdates({
        ok: true,
        result: [
          {
            update_id: 123,
            message: {
              message_id: 7,
              from: { id: 1001, is_bot: false, username: "dianov" },
              chat: { id: 42, type: "private" },
              text: "yo",
            },
          },
        ],
      }),
    ),
  );

  assert.equal(Either.isRight(decoded), true);
  if (Either.isRight(decoded)) {
    assert.deepEqual(decoded.right, [{ updateId: 123, message: ownerMessage }]);
  }
});

test("private photo captions retain only the largest documented photo variant", async () => {
  const decoded = await Effect.runPromise(
    decodeTelegramUpdates({
      ok: true,
      result: [
        {
          update_id: 124,
          message: {
            message_id: 8,
            from: { id: 1001, is_bot: false, username: "dianov" },
            chat: { id: 42, type: "private" },
            caption: "Can you see this?",
            photo: [
              {
                file_id: "small-file",
                file_unique_id: "small-unique",
                width: 90,
                height: 90,
                file_size: 2_000,
              },
              {
                file_id: "large-file",
                file_unique_id: "large-unique",
                width: 1_280,
                height: 720,
                file_size: 200_000,
              },
            ],
          },
        },
      ],
    }),
  );

  assert.deepEqual(decoded, [
    {
      updateId: 124,
      message: {
        ...ownerMessage,
        messageId: 8,
        text: "Can you see this?",
        photo: {
          fileId: "large-file",
          width: 1_280,
          height: 720,
          fileSize: 200_000,
        },
      },
    },
  ]);
});

test("edited owner messages retain their identity as corrections", async () => {
  assert.deepEqual(
    await Effect.runPromise(
      decodeTelegramUpdates({
        ok: true,
        result: [
          {
            update_id: 125,
            edited_message: {
              message_id: 7,
              from: { id: 1001, is_bot: false, username: "dianov" },
              chat: { id: 42, type: "private" },
              text: "edited text",
            },
          },
        ],
      }),
    ),
    [
      {
        updateId: 125,
        message: { ...ownerMessage, text: "edited text", edited: true },
      },
    ],
  );
});

test("private owner reactions decode as bounded feedback", async () => {
  assert.deepEqual(
    await Effect.runPromise(
      decodeTelegramUpdates({
        ok: true,
        result: [
          {
            update_id: 126,
            message_reaction: {
              chat: { id: 42, type: "private" },
              message_id: 77,
              user: { id: 1001, is_bot: false, username: "dianov" },
              new_reaction: [{ type: "emoji", emoji: "🔥" }],
            },
          },
        ],
      }),
    ),
    [
      {
        updateId: 126,
        reaction: {
          chatId: 42,
          messageId: 77,
          userId: 1001,
          username: "dianov",
          emojis: ["🔥"],
        },
      },
    ],
  );
});

test("ignored Telegram updates retain their offset so they cannot wedge polling", async () => {
  assert.deepEqual(
    await Effect.runPromise(
      decodeTelegramUpdates({
        ok: true,
        result: [{ update_id: 126, channel_post: { untrusted: true } }],
      }),
    ),
    [{ updateId: 126 }],
  );
});

test("adjacent owner text bursts coalesce while commands and replies remain boundaries", () => {
  const updates = [
    { updateId: 200, message: { ...ownerMessage, text: "first" } },
    {
      updateId: 201,
      message: { ...ownerMessage, messageId: 8, text: "second" },
    },
    {
      updateId: 202,
      message: {
        ...ownerMessage,
        messageId: 9,
        text: "screenshot context",
        photo: { fileId: "screen", width: 1_200, height: 800 },
      },
    },
    {
      updateId: 203,
      message: { ...ownerMessage, messageId: 10, text: "/agents" },
    },
    {
      updateId: 204,
      message: {
        ...ownerMessage,
        messageId: 11,
        text: "answer",
        replyToMessageId: 77,
      },
    },
    {
      updateId: 205,
      message: { ...ownerMessage, messageId: 12, text: "third" },
    },
  ];

  assert.deepEqual(coalesceTelegramUpdates(updates), [
    {
      updateId: 202,
      message: {
        ...ownerMessage,
        messageId: 9,
        text: "first\n\nsecond\n\nscreenshot context",
        photo: { fileId: "screen", width: 1_200, height: 800 },
      },
    },
    updates[3],
    updates[4],
    updates[5],
  ]);
});

test("an edit inside a pending burst replaces its original while a later edit becomes a correction", () => {
  const original = {
    updateId: 300,
    message: { ...ownerMessage, text: "wrong wording" },
  };
  const edited = {
    updateId: 301,
    message: { ...ownerMessage, text: "right wording", edited: true as const },
  };
  const laterEdit = {
    updateId: 302,
    message: {
      ...ownerMessage,
      messageId: 99,
      text: "late correction",
      edited: true as const,
    },
  };

  assert.deepEqual(coalesceTelegramUpdates([original, edited, laterEdit]), [
    {
      updateId: 301,
      message: { ...ownerMessage, text: "right wording" },
    },
    {
      updateId: 302,
      message: {
        ...ownerMessage,
        messageId: 99,
        text: "[Correction to my earlier message #99]\nlate correction",
      },
    },
  ]);
});

test("private replies retain only the referenced Telegram message id", async () => {
  const decoded = await Effect.runPromise(
    decodeTelegramUpdates({
      ok: true,
      result: [
        {
          update_id: 124,
          message: {
            message_id: 8,
            from: { id: 1001, is_bot: false, username: "dianov" },
            chat: { id: 42, type: "private" },
            text: "Ship it",
            reply_to_message: { message_id: 77, text: "untrusted quoted text" },
          },
        },
      ],
    }),
  );

  assert.deepEqual(decoded, [
    {
      updateId: 124,
      message: {
        ...ownerMessage,
        messageId: 8,
        text: "Ship it",
        replyToMessageId: 77,
      },
    },
  ]);
});

test("malformed Telegram reply references fail through the typed error channel", async () => {
  const decoded = await Effect.runPromise(
    Effect.either(
      decodeTelegramUpdates({
        ok: true,
        result: [
          {
            update_id: 124,
            message: {
              message_id: 8,
              from: { id: 1001, is_bot: false, username: "dianov" },
              chat: { id: 42, type: "private" },
              text: "Ship it",
              reply_to_message: { message_id: "77" },
            },
          },
        ],
      }),
    ),
  );

  assert.equal(Either.isLeft(decoded), true);
  if (Either.isLeft(decoded))
    assert.equal(decoded.left._tag, "TelegramContractError");
});

test("Telegram file downloads stay on a bounded relative path and allowed image media", async () => {
  assert.equal(
    await Effect.runPromise(
      decodeTelegramFilePath({
        ok: true,
        result: { file_id: "opaque", file_path: "photos/file_1.jpg" },
      }),
    ),
    "photos/file_1.jpg",
  );
  for (const filePath of [
    "https://attacker.invalid/file.jpg",
    "../secret",
    "/absolute/file.jpg",
    "photos/file.jpg?redirect=https://attacker.invalid",
  ]) {
    assert.equal(
      Either.isLeft(
        await Effect.runPromise(
          Effect.either(
            decodeTelegramFilePath({
              ok: true,
              result: { file_path: filePath },
            }),
          ),
        ),
      ),
      true,
    );
  }

  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xdb, 0x00]);
  assert.deepEqual(
    await Effect.runPromise(
      telegramImageFromBytes("application/octet-stream", jpeg),
    ),
    {
      mediaType: "image/jpeg",
      data: jpeg.toString("base64"),
    },
  );
  for (const [contentType, bytes] of [
    ["text/html", Buffer.from("not-an-image")],
    ["image/png", jpeg],
  ] as const) {
    assert.equal(
      Either.isLeft(
        await Effect.runPromise(
          Effect.either(telegramImageFromBytes(contentType, bytes)),
        ),
      ),
      true,
    );
  }
});

test("Telegram boolean method responses require an explicit ok envelope", async () => {
  await Effect.runPromise(decodeTelegramOk({ ok: true, result: true }));
  assert.equal(
    Either.isLeft(
      await Effect.runPromise(
        Effect.either(
          decodeTelegramOk({
            ok: false,
            error_code: 400,
            description: "Bad Request",
          }),
        ),
      ),
    ),
    true,
  );
});

test("sendMessage responses decode only the documented message id", async () => {
  assert.equal(
    await Effect.runPromise(
      decodeTelegramSentMessageId({ ok: true, result: { message_id: 77 } }),
    ),
    77,
  );
  assert.equal(
    Either.isLeft(
      await Effect.runPromise(
        Effect.either(
          decodeTelegramSentMessageId({
            ok: true,
            result: { message_id: "77" },
          }),
        ),
      ),
    ),
    true,
  );
});

test("malformed Telegram envelopes fail through the typed error channel", async () => {
  const decoded = await Effect.runPromise(
    Effect.either(
      decodeTelegramUpdates({ ok: true, result: [{ update_id: "bad" }] }),
    ),
  );

  assert.equal(Either.isLeft(decoded), true);
  if (Either.isLeft(decoded))
    assert.equal(decoded.left._tag, "TelegramContractError");
});
