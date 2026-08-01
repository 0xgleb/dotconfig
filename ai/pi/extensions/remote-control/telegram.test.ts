import assert from "node:assert/strict";
import test from "node:test";
import * as Effect from "effect/Effect";
import * as Either from "effect/Either";

import {
  authorizeTelegramMessage,
  decodeTelegramFilePath,
  decodeTelegramOk,
  decodeTelegramSentMessageId,
  decodeTelegramUpdates,
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

test("unauthorized senders never alter owner state and receive fresh clanker rejections", () => {
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
  assert.notEqual(first.text, second.text);
  assert.match(first.text, /not your clanker/i);
  assert.match(second.text, /not your clanker/i);
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

test("ignored Telegram updates retain their offset so they cannot wedge polling", async () => {
  assert.deepEqual(
    await Effect.runPromise(
      decodeTelegramUpdates({
        ok: true,
        result: [{ update_id: 125, edited_message: { untrusted: true } }],
      }),
    ),
    [{ updateId: 125 }],
  );
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

  assert.deepEqual(
    await Effect.runPromise(
      telegramImageFromBytes("image/jpeg", Buffer.from("image-fixture")),
    ),
    {
      mediaType: "image/jpeg",
      data: Buffer.from("image-fixture").toString("base64"),
    },
  );
  assert.equal(
    Either.isLeft(
      await Effect.runPromise(
        Effect.either(
          telegramImageFromBytes("text/html", Buffer.from("not-an-image")),
        ),
      ),
    ),
    true,
  );
});

test("Telegram boolean method responses require an explicit ok envelope", async () => {
  await Effect.runPromise(decodeTelegramOk({ ok: true, result: true }))
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
  )
})

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
