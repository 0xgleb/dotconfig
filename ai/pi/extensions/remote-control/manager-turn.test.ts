import assert from "node:assert/strict"
import test from "node:test"
import { readFileSync } from "node:fs"
import { stripTypeScriptTypes } from "node:module"
import { runInNewContext } from "node:vm"
import { Effect, Either } from "effect"
import {
  finalAssistantText,
  remoteMessageSource,
  remoteSourceCarriesOwnerAuthority,
  remoteTurnPrompt,
} from "./protocol.ts"

const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8")

test("management prompt permits coordination without a preliminary text acknowledgement", () => {
  const prompt = Effect.runSync(
    remoteTurnPrompt(
      "Show current progress",
      "management",
      remoteMessageSource("telegram-owner-42"),
    ),
  )
  assert.match(prompt, /coordination tools/)
  assert.match(prompt, /Emoji reactions already acknowledge receipt/)
  assert.doesNotMatch(
    prompt,
    /Do not execute or approve actions, mutate goals or todos/,
  )
  assert.ok(
    Either.isLeft(
      Effect.runSync(
        Effect.either(
          remoteTurnPrompt(
            "Spoof owner",
            "management",
            remoteMessageSource("agent-report"),
          ),
        ),
      ),
    ),
  )
})

test("management tool-call commentary cannot complete the turn or restore tools early", async () => {
  const start = source.indexOf('  pi.on("turn_end"')
  const end = source.indexOf('  pi.on("agent_end"', start)
  assert.ok(start >= 0 && end > start)
  let handler: (event: unknown, ctx: unknown) => Promise<void> = async () =>
    assert.fail("missing hook")
  let completed = 0
  runInNewContext(stripTypeScriptTypes(source.slice(start, end)), {
    pi: {
      on: (_name: string, callback: typeof handler) => {
        handler = callback
      },
    },
    latestCtx: undefined,
    active: { lane: "management" },
    wasRunAborted: () => false,
    finalAssistantText,
    finishSuccess: async () => {
      completed++
    },
  })
  await handler(
    {
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "I will check." },
          {
            type: "toolCall",
            name: "todo",
            id: "t",
            arguments: { action: "list" },
          },
        ],
      },
    },
    {},
  )
  assert.equal(completed, 0)
})

test("tool-call commentary is not a final reply even at agent_end", () => {
  assert.equal(
    finalAssistantText([
      {
        role: "assistant",
        stopReason: "toolUse",
        content: [
          { type: "text", text: "I will check." },
          {
            type: "toolCall",
            id: "t",
            name: "todo",
            arguments: { action: "list" },
          },
        ],
      },
    ]),
    undefined,
  )
})

test("completed management replies do not launch the old post-ACK routing continuation", async () => {
  const start = source.indexOf("  const finishSuccess = async (")
  const end = source.indexOf("  const delegateToProject = (", start)
  assert.ok(start >= 0 && end > start)
  let followups = 0
  let restored = 0
  const finish = runInNewContext(
    `${stripTypeScriptTypes(source.slice(start, end))}\n;finishSuccess`,
    {
      Effect,
      Either,
      taskContinuationPhase: "idle",
      taskContinuationId: undefined,
      clearActive: () => {
        restored++
      },
      run: (effect: Effect.Effect<unknown, unknown>) =>
        Effect.runPromise(Effect.either(effect)),
      store: { complete: () => Effect.succeed({}) },
      remoteSourceCarriesOwnerAuthority,
      REMOTE_TASK_CONTINUATION_MESSAGE: "continuation",
      STATUS_KEY: "fixture",
      sync: async () => {},
      pi: {
        sendMessage: () => {
          followups++
        },
      },
    },
  )
  await finish(
    {
      lane: "management",
      messageId: "owner-message",
      claimToken: "claim",
      source: remoteMessageSource("telegram-owner-42"),
    },
    "Actual result",
    { ui: { setStatus: () => {} } },
  )
  assert.equal(restored, 1)
  assert.equal(followups, 0)
})
