import assert from "node:assert/strict"
import test from "node:test"
import * as Effect from "effect/Effect"
import * as Either from "effect/Either"

import {
  authorizeTelegramMessage,
  decodeTelegramUpdates,
  freshClankerRejection,
  initialTelegramBotState,
} from "./telegram.ts"

const ownerMessage = { chatId: 42, messageId: 7, userId: 1001, username: "dianov", text: "yo" }

test("the first @dianov message pins the immutable owner user id", () => {
  const authorization = authorizeTelegramMessage(initialTelegramBotState, ownerMessage, "dianov")

  assert.equal(authorization.kind, "owner")
  assert.equal(authorization.ownerPinned, true)
  assert.equal(authorization.state.ownerUserId, 1001)
})

test("owner authorization requires both the pinned id and current username", () => {
  const pinned = { ...initialTelegramBotState, ownerUserId: 1001 }
  const wrongId = authorizeTelegramMessage(
    pinned,
    { ...ownerMessage, userId: 9999 },
    "dianov",
  )
  const missingUsername = authorizeTelegramMessage(
    pinned,
    { ...ownerMessage, username: undefined },
    "dianov",
  )

  assert.equal(wrongId.kind, "rejected")
  assert.equal(missingUsername.kind, "rejected")
  assert.deepEqual(wrongId.state, pinned)
  assert.deepEqual(missingUsername.state, pinned)
})

test("unauthorized senders never alter owner state and receive fresh clanker rejections", () => {
  const stranger = { ...ownerMessage, userId: 2002, username: "stranger" }
  const authorization = authorizeTelegramMessage(initialTelegramBotState, stranger, "dianov")
  const first = freshClankerRejection(0)
  const second = freshClankerRejection(first.nextCounter)

  assert.equal(authorization.kind, "rejected")
  assert.deepEqual(authorization.state, initialTelegramBotState)
  assert.notEqual(first.text, second.text)
  assert.match(first.text, /not your clanker/i)
  assert.match(second.text, /not your clanker/i)
})

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
  )

  assert.equal(Either.isRight(decoded), true)
  if (Either.isRight(decoded)) {
    assert.deepEqual(decoded.right, [{ updateId: 123, message: ownerMessage }])
  }
})

test("malformed Telegram envelopes fail through the typed error channel", async () => {
  const decoded = await Effect.runPromise(
    Effect.either(decodeTelegramUpdates({ ok: true, result: [{ update_id: "bad" }] })),
  )

  assert.equal(Either.isLeft(decoded), true)
  if (Either.isLeft(decoded)) assert.equal(decoded.left._tag, "TelegramContractError")
})
