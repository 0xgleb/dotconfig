import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { stripTypeScriptTypes } from "node:module"
import { runInNewContext } from "node:vm"
import test from "node:test"
import { Effect, Either } from "effect"
import { decodeTelegramSentMessageId } from "./telegram.ts"

const source = readFileSync(
  new URL("./owner-telegram.ts", import.meta.url),
  "utf8",
)
const start = source.indexOf("export const editOwnerQuestionRelay = (")
const end = source.indexOf("export type ChatRelayDispatch", start)
assert.ok(start >= 0 && end > start)
const compiled = stripTypeScriptTypes(
  source.slice(start, end).replace("export const", "const"),
)
interface Receipt {
  readonly messageId: number
  readonly textLinks: number
}
const fixture = (payload: unknown) => {
  const calls: RequestInit[] = []
  const edit = runInNewContext(`${compiled}\n;editOwnerQuestionRelay`, {
    Effect,
    decodeTelegramSentMessageId,
    telegramToken: Effect.succeed("synthetic-token"),
    ownerChatId: Effect.succeed(1_001),
    deliveryFailure: (code: string, message: string) => ({ code, message }),
    stateField: (value: unknown, field: string) =>
      typeof value === "object" && value !== null && !Array.isArray(value)
        ? Reflect.get(value, field)
        : undefined,
    fetch: async (_url: string, options: RequestInit) => {
      calls.push(options)
      return { ok: true, json: async () => payload }
    },
  }) as (
    input: { chatId: number; messageId: number; text: string },
    signal?: AbortSignal,
  ) => Effect.Effect<Receipt, { code: string }>
  return { calls, edit }
}
const input = {
  chatId: 1_001,
  messageId: 42,
  text: '<a href="https://example.test/one">one</a> <a href="https://example.test/two">two</a>',
}

test("edits the existing bound message in HTML mode and reports actual Telegram link entities", async () => {
  const f = fixture({
    ok: true,
    result: {
      message_id: 42,
      entities: [
        { type: "text_link", url: "https://example.test/one" },
        { type: "text_link", url: "https://example.test/two" },
      ],
    },
  })
  const result = await Effect.runPromise(Effect.either(f.edit(input)))
  assert.ok(Either.isRight(result))
  assert.deepEqual(JSON.parse(JSON.stringify(result.right)), {
    messageId: 42,
    textLinks: 2,
  })
  const body = JSON.parse(String(f.calls[0]?.body))
  assert.equal(body.chat_id, 1_001)
  assert.equal(body.message_id, 42)
  assert.equal(body.parse_mode, "HTML")
  assert.equal(body.text, input.text)
})

test("another chat cannot be edited, even with an otherwise valid message id", async () => {
  const f = fixture({ ok: true, result: { message_id: 42 } })
  const result = await Effect.runPromise(
    Effect.either(f.edit({ ...input, chatId: 2_002 })),
  )
  assert.ok(Either.isLeft(result))
  assert.equal(result.left.code, "invalid_binding")
  assert.equal(f.calls.length, 0)
})

test("a cancelled presentation refresh makes no HTTP request", async () => {
  const f = fixture({ ok: true, result: { message_id: 42 } })
  const controller = new AbortController()
  controller.abort()
  const result = await Effect.runPromise(
    Effect.either(f.edit(input, controller.signal)),
  )
  assert.ok(Either.isLeft(result))
  assert.equal(result.left.code, "send_cancelled")
  assert.equal(f.calls.length, 0)
})

for (const payload of [
  { ok: true, result: { message_id: 99 } },
  { ok: true, result: { message_id: 42, entities: [null] } },
  { ok: true, result: { message_id: 42, entities: {} } },
]) {
  test(`wrong message or malformed entity receipt cannot certify the refresh: ${JSON.stringify(payload)}`, async () => {
    const f = fixture(payload)
    const result = await Effect.runPromise(Effect.either(f.edit(input)))
    assert.ok(Either.isLeft(result))
  })
}
