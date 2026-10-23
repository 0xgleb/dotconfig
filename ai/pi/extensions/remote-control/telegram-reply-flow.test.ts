import assert from "node:assert/strict"
import test from "node:test"
import { readFileSync, mkdtempSync, rmSync } from "node:fs"
import { stripTypeScriptTypes } from "node:module"
import { runInNewContext } from "node:vm"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Data, Effect, Either } from "effect"
import { makeRemoteBridgeStore } from "./sqlite-store.ts"
import { managerDefaultAgent } from "./agent-selection.ts"
import { workDeliveryAcceptsInbox } from "./protocol.ts"
import { telegramDirectOwnerText } from "./telegram.ts"
import { telegramHtmlChunks } from "./telegram-format.ts"

const source = readFileSync(
  new URL("./piece-of-pi.ts", import.meta.url),
  "utf8",
)
class TransportError extends Data.TaggedError("TransportError")<{
  method: string
  message: string
}> {}
const fixture = (t: test.TestContext) => {
  const root = mkdtempSync(join(tmpdir(), "pi-telegram-reply-flow-"))
  t.after(() => rmSync(root, { recursive: true }))
  return makeRemoteBridgeStore(join(root, "bridge.sqlite"))
}
const worker = {
  id: "worker",
  label: "Worker",
  cwd: "/work/worker",
  workDelivery: "native-pi",
  accepting: true,
}
const manager = {
  ...worker,
  id: "manager",
  label: "Manager",
  cwd: "/manager/global",
  nativeManager: true,
}
const extract = (start: string, end: string) => {
  const first = source.indexOf(start)
  const last = source.indexOf(end, first)
  assert.ok(first >= 0 && last > first)
  return stripTypeScriptTypes(source.slice(first, last))
}

for (const origin of [undefined, "worker", "offline-worker"]) {
  test(`exact reply origin overrides manager only for that message: ${origin}`, async t => {
    const store = fixture(t)
    if (origin)
      await Effect.runPromise(
        store.linkTelegramMessageOrigin({
          agentId: origin,
          chatId: 42,
          messageId: 100,
        }),
      )
    const choose = runInNewContext(
      `${extract("const chooseAgent = (", "interface BridgeFeedbackState")}\n;chooseAgent`,
      {
        Effect,
        managerDefaultAgent,
        workDeliveryAcceptsInbox,
        TelegramTransportError: TransportError,
        availableChatAgents: () => Effect.succeed([worker, manager]),
        availableAgents: () => Effect.succeed([worker, manager]),
      },
    )
    const result = await Effect.runPromise(
      Effect.either(
        choose(
          { bridge: store },
          {
            chatId: 42,
            messageId: 1,
            userId: 42,
            text: "Follow up",
            replyToMessageId: 100,
          },
        ),
      ),
    )
    if (origin === "offline-worker") {
      assert.ok(Either.isLeft(result))
      return
    }
    assert.ok(Either.isRight(result))
    assert.equal(result.right.id, origin ?? "manager")
    const ordinary = await Effect.runPromise(
      choose(
        { bridge: store },
        { chatId: 42, messageId: 2, userId: 42, text: "Next topic" },
      ),
    )
    assert.equal(
      ordinary.id,
      "manager",
      "reply routing must never become global selection",
    )
  })
}

for (const failSecond of [false, true]) {
  test(`every confirmed response chunk is reply-addressable, including partial delivery: ${failSecond}`, async t => {
    const store = fixture(t)
    let calls = 0
    const send = runInNewContext(
      `${extract("const sendFormattedText = (", "interface TelegramUpdateRequest")}\n;sendFormattedText`,
      {
        Effect,
        telegramHtmlChunks,
        TELEGRAM_MESSAGE_LIMIT: 4000,
        TelegramTransportError: TransportError,
        sendTelegramMessage: () => {
          calls++
          return calls === 2 && failSecond
            ? Effect.fail(
                new TransportError({
                  method: "sendMessage",
                  message: "Fixture failure",
                }),
              )
            : Effect.succeed(100 + calls)
        },
      },
    )
    const result = await Effect.runPromise(
      Effect.either(
        send({ bridge: store }, 42, "x".repeat(4500), undefined, "worker"),
      ),
    )
    assert.equal(Either.isLeft(result), failSecond)
    assert.equal(
      await Effect.runPromise(
        store.getTelegramMessageOrigin({ chatId: 42, messageId: 101 }),
      ),
      "worker",
    )
    assert.equal(
      await Effect.runPromise(
        store.getTelegramMessageOrigin({ chatId: 42, messageId: 102 }),
      ),
      failSecond ? undefined : "worker",
    )
  })
}

test("ordinary text is never consumed as an implicit answer to the sole pending question", async () => {
  const reply = runInNewContext(
    `${extract("const handleQuestionReply = (", "const ensureCabaSession = (")}\n;handleQuestionReply`,
    { Effect, telegramDirectOwnerText },
  )
  let attempted = 0
  const result = await Effect.runPromise(
    reply(
      {
        bridge: {
          answerSolePendingTelegramQuestion: () => {
            attempted++
            return Effect.succeed(undefined)
          },
        },
      },
      { message: { chatId: 42, messageId: 1, userId: 42, text: "1" } },
    ),
  )
  assert.equal(attempted, 0)
  assert.equal(result, false)
})

test("an exact pending-question reply resolves without a text acknowledgement", async () => {
  let sent = 0
  const reply = runInNewContext(
    `${extract("const handleQuestionReply = (", "const ensureCabaSession = (")}\n;handleQuestionReply`,
    {
      Effect,
      telegramDirectOwnerText,
      availableAgents: () => Effect.succeed([worker]),
      identifiedAgentLabel: () => "Worker",
      emit: () => {},
      sendText: () => {
        sent++
        return Effect.void
      },
    },
  )
  const result = await Effect.runPromise(
    reply(
      {
        bridge: {
          answerTelegramQuestion: () =>
            Effect.succeed({ agentId: "worker", questionId: 7 }),
        },
      },
      {
        message: {
          chatId: 42,
          messageId: 1,
          userId: 42,
          text: "1",
          replyToMessageId: 100,
        },
      },
    ),
  )
  assert.equal(result, true)
  assert.equal(sent, 0)
})
