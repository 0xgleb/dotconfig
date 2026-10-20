import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { stripTypeScriptTypes } from "node:module"
import { runInNewContext } from "node:vm"
import test from "node:test"
import { Effect, Either } from "effect"
import { ownerRelayChunks } from "./owner-telegram.ts"

const source = readFileSync(
  new URL("./owner-telegram.ts", import.meta.url),
  "utf8",
)
const relayStart = source.indexOf("const sendRelay = (")
const relayEnd = source.indexOf("const deliveryFailure = (", relayStart)
const sendStart = source.indexOf("const sendOwnerMessage = (")
assert.ok(relayStart >= 0 && relayEnd > relayStart && sendStart > relayEnd)
const compiled = stripTypeScriptTypes(
  source.slice(relayStart, relayEnd) + source.slice(sendStart),
)
const fixture = (
  fetch: (url: string, options: RequestInit) => Promise<unknown>,
) =>
  runInNewContext(`${compiled}\n;({ sendRelay, sendOwnerMessage })`, {
    Effect,
    fetch,
    ownerRelayChunks,
    deliveryFailure: (code: string, message: string) => ({ code, message }),
    hasMultipleLinks: () => false,
    decodeTelegramSentMessageId: () => Effect.succeed(42),
  }) as {
    sendRelay: (
      token: string,
      id: number,
      text: string,
      signal?: AbortSignal,
    ) => Effect.Effect<void, { code: string }>
    sendOwnerMessage: (
      token: string,
      id: number,
      text: string,
      markup?: unknown,
      signal?: AbortSignal,
    ) => Effect.Effect<number, { code: string }>
  }

test("actual transport refuses a pre-cancelled send without attempting HTTP", async () => {
  let calls = 0
  const controller = new AbortController()
  controller.abort()
  const sender = fixture(async () => {
    calls++
    assert.fail("must not fetch")
  })
  const result = await Effect.runPromise(
    Effect.either(
      sender.sendOwnerMessage(
        "synthetic-token",
        1,
        "Fixture",
        undefined,
        controller.signal,
      ),
    ),
  )
  assert.ok(Either.isLeft(result))
  assert.equal(result.left.code, "send_cancelled")
  assert.equal(calls, 0)
})

test("actual transport carries the abort signal and labels interrupted HTTP delivery uncertain", async () => {
  const controller = new AbortController()
  let signal: AbortSignal | null | undefined
  const sender = fixture(async (_url, options) => {
    signal = options.signal
    controller.abort()
    throw new Error("synthetic aborted HTTP")
  })
  const result = await Effect.runPromise(
    Effect.either(
      sender.sendOwnerMessage(
        "synthetic-token",
        1,
        "Fixture",
        undefined,
        controller.signal,
      ),
    ),
  )
  assert.equal(signal, controller.signal)
  assert.ok(Either.isLeft(result))
  assert.equal(result.left.code, "send_uncertain")
})

test("partial multi-chunk delivery never claims the whole report was unsent", async () => {
  const controller = new AbortController()
  let calls = 0
  const sender = fixture(async () => {
    calls++
    controller.abort()
    return {
      ok: true,
      json: async () => ({ ok: true, result: { message_id: 42 } }),
    }
  })
  const result = await Effect.runPromise(
    Effect.either(
      sender.sendRelay(
        "synthetic-token",
        1,
        "A".repeat(5_000),
        controller.signal,
      ),
    ),
  )
  assert.ok(Either.isLeft(result))
  assert.equal(result.left.code, "send_uncertain")
  assert.equal(calls, 1)
})
