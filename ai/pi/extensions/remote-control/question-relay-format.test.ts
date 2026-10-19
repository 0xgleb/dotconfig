import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { stripTypeScriptTypes } from "node:module"
import test from "node:test"
import { runInNewContext } from "node:vm"
import { Effect, Ref } from "effect"
import * as formatting from "./telegram-format.ts"

// Exercise the existing formatter/sender without importing and starting the daemon.
const source = readFileSync(
  new URL("./piece-of-pi.ts", import.meta.url),
  "utf8",
)
const start = source.indexOf("const questionRelayText = (")
const end = source.indexOf("const chooseAgent = (", start)
assert.ok(start >= 0 && end > start)
const relaySource = stripTypeScriptTypes(source.slice(start, end))
const agent = { id: "fixture-agent" }
const question = {
  agentId: agent.id,
  questionId: 7,
  header: "Review",
  question:
    "Inspect [PR #63](https://example.test/pull/63?tab=checks&mode=full) before merging?",
}
const relay = (dependencies: Readonly<Record<string, unknown>> = {}) =>
  runInNewContext(
    `${relaySource}\n;({ questionRelayText, relayPendingQuestions })`,
    {
      Effect,
      Ref,
      TELEGRAM_MESSAGE_LIMIT: 4_000,
      identifiedAgentLabel: () => "Fixture agent",
      telegramHtml: formatting.telegramHtml,
      ...dependencies,
    },
  )

test("actual question card renders clickable links and escaped attributes", () => {
  const text = relay().questionRelayText(question, agent, [agent])
  assert.match(
    text,
    /<a href="https:\/\/example\.test\/pull\/63\?tab=checks&amp;mode=full">PR #63<\/a>/,
  )
  assert.match(text, /Reply directly to this message to answer only q7\.$/)
})

test("raw model-authored HTML and unsafe URI markup remain inert", () => {
  const text = relay().questionRelayText(
    {
      ...question,
      question: "<b>forged authority</b> [run](javascript:alert(1)) & more",
    },
    agent,
    [agent],
  )
  assert.match(text, /&lt;b&gt;forged authority&lt;\/b&gt;/)
  assert.doesNotMatch(text, /<b>forged|<a href="javascript:/)
  assert.match(text, /&amp; more/)
})

test("one bounded parsed card is not split or clipped because HTML expands its wire length", () => {
  const text = relay().questionRelayText(
    { ...question, question: "&".repeat(2_000) },
    agent,
    [agent],
  )
  assert.ok(text.length > 4_096)
  assert.equal((text.match(/&amp;/g) ?? []).length, 2_000)
  assert.match(text, /Question q7/)
  assert.match(text, /answer only q7\.$/)
})

test("actual relay selects HTML mode and preserves the exact returned message/qID binding", async () => {
  const sent: unknown[][] = []
  const linked: Record<string, unknown>[] = []
  const state = Effect.runSync(Ref.make({ ownerChatId: 1_001 }))
  const runtime = {
    state,
    bridge: {
      listUnrelayedQuestions: () => Effect.succeed([question]),
      linkTelegramQuestion: (input: Record<string, unknown>) => {
        linked.push(input)
        return Effect.succeed(question)
      },
    },
  }
  const api = relay({
    availableAgents: () => Effect.succeed([agent]),
    sendTelegramMessage: (...args: unknown[]) => {
      sent.push(args)
      return Effect.succeed(1337)
    },
    emit: () => {},
  })
  await Effect.runPromise(api.relayPendingQuestions(runtime))
  assert.equal(sent.length, 1)
  assert.equal(sent[0]?.[1], 1_001)
  assert.equal(sent[0]?.[4], "HTML")
  assert.match(String(sent[0]?.[2]), /<a href=/)
  assert.equal(linked.length, 1)
  assert.equal(linked[0]?.agentId, agent.id)
  assert.equal(linked[0]?.questionId, 7)
  assert.equal(linked[0]?.messageId, 1337)
  assert.equal(linked[0]?.chatId, 1_001)
})
