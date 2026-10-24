import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { stripTypeScriptTypes } from "node:module"
import { runInNewContext } from "node:vm"
import test from "node:test"
import { Data, Effect, Either, Ref } from "effect"
import {
  telegramHasDirectOwnerInput,
  telegramDirectOwnerText,
  telegramOwnerConversationText,
} from "./telegram.ts"
import { managerDefaultAgent, preferredAgent } from "./agent-selection.ts"
import {
  getManagerBinding,
  registerManagerBinding,
  type ManagerBinding,
} from "../shared/manager-binding.ts"
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent"

const daemon = readFileSync(
  new URL("./piece-of-pi.ts", import.meta.url),
  "utf8",
)
const extension = readFileSync(new URL("./index.ts", import.meta.url), "utf8")
class TransportError extends Data.TaggedError("TransportError")<{
  message: string
  method: string
}> {}
const workers = [
  {
    id: "worker",
    label: ".config",
    cwd: "/projects/.config",
    accepting: true,
    workDelivery: "native-pi",
    nativeManager: undefined,
  },
]
const manager = {
  ...workers[0],
  id: "manager",
  cwd: "/manager/global",
  nativeManager: true,
}

for (const [state, expected] of [
  [{}, "manager"],
  [{ selectedAgentId: "worker" }, "manager"],
  [{ selectedAgentId: "worker", explicitAgentSelection: true }, "manager"],
] as const) {
  test(`actual bot selection defaults to manager, explicit override=${"explicitAgentSelection" in state}`, async () => {
    const start = daemon.indexOf("const chooseAgent = (")
    const end = daemon.indexOf("interface BridgeFeedbackState", start)
    assert.ok(start >= 0 && end > start)
    const choose = runInNewContext(
      `${stripTypeScriptTypes(daemon.slice(start, end))}\n;chooseAgent`,
      {
        Effect,
        preferredAgent,
        managerDefaultAgent,
        TelegramTransportError: TransportError,
        availableChatAgents: () => Effect.succeed([...workers, manager]),
      },
    )
    const chosen = await Effect.runPromise(choose({}, state))
    assert.equal(chosen.id, expected)
  })
}

for (const binding of [
  { role: "worker" },
  { role: "manager-unavailable", message: "No worker selected" },
  { role: "manager", workerSessionId: "worker", workerCwd: "/projects/worker" },
] satisfies ManagerBinding[]) {
  test(`actual remote heartbeat derives profile from scoped binding: ${binding.role}`, async () => {
    const listeners = new Map<string, ((data: unknown) => void)[]>()
    const pi = {
      events: {
        on: (name: string, listener: (data: unknown) => void) => {
          listeners.set(name, [...(listeners.get(name) ?? []), listener])
          return () => {}
        },
        emit: (name: string, data: unknown) => {
          for (const listener of listeners.get(name) ?? []) listener(data)
        },
      },
    } as unknown as ExtensionAPI
    registerManagerBinding(pi, id => (id === "self" ? binding : undefined))
    const captured: Record<string, unknown>[] = []
    const start = extension.indexOf("  const sync = async (")
    const end = extension.indexOf('  pi.on("context"', start)
    assert.ok(start >= 0 && end > start)
    const sync = runInNewContext(
      `${stripTypeScriptTypes(extension.slice(start, end))}\n;sync`,
      {
        Effect,
        Either,
        getManagerBinding,
        pi,
        syncing: false,
        latestCtx: undefined,
        active: undefined,
        taskContinuationPhase: "idle",
        questionsDirty: false,
        BRIDGE_AGENT_TTL_MS: 15000,
        STATUS_KEY: "fixture",
        safeError: () => "binding error",
        bridgeAgentLabel: () => "fixture",
        run: (operation: Effect.Effect<unknown, unknown>) =>
          Effect.runPromise(Effect.either(operation)),
        canClaimRemoteTurn: () => false,
        store: {
          heartbeatAgent: (input: Record<string, unknown>) => {
            captured.push(input)
            return Effect.succeed({})
          },
          takeQuestionResolution: () => Effect.succeed(undefined),
        },
      },
    )
    const ctx = {
      cwd: "/manager/global",
      sessionManager: { getSessionId: () => "self", getBranch: () => [] },
      ui: { setStatus: () => {} },
    } as unknown as ExtensionContext
    await sync(ctx)
    assert.equal(captured.length, 1)
    assert.equal(
      captured[0]?.nativeManager,
      binding.role === "worker" ? undefined : true,
    )
  })
}

for (const forwarded of [false, true]) {
  test(`actual owner enqueue grants instruction provenance only to direct input: forwarded=${forwarded}`, async () => {
    const start = daemon.indexOf("const enqueueOwnerMessage = (")
    const end = daemon.indexOf("const selectAgent = (", start)
    assert.ok(start >= 0 && end > start)
    let requesterId = ""
    const enqueue = runInNewContext(
      `${stripTypeScriptTypes(daemon.slice(start, end))}\n;enqueueOwnerMessage`,
      {
        Effect,
        Ref,
        telegramHasDirectOwnerInput,
        telegramOwnerConversationText,
        BRIDGE_MESSAGE_TTL_MS: 3600000,
        sendTelegramAction: () => Effect.void,
        chooseAgent: () => Effect.succeed(manager),
        awaitBridgeResult: () => Effect.void,
        BRIDGE_TYPING_REFRESH_MS: 4000,
      },
    )
    const runtime = {
      state: Effect.runSync(Ref.make({})),
      bridge: {
        enqueue: (input: { requesterId: string }) => {
          requesterId = input.requesterId
          return Effect.succeed({ id: "message" })
        },
      },
    }
    await Effect.runPromise(
      enqueue(runtime, {
        updateId: 1,
        message: {
          userId: 42,
          chatId: 42,
          messageId: 1,
          text: "/use worker",
          ...(forwarded
            ? { forwardOrigin: { speaker: "owner", userId: 42 } }
            : {}),
        },
      }),
    )
    assert.equal(
      requesterId,
      forwarded ? "telegram-forwarded-42" : "telegram-owner-42",
    )
  })
}

test("forwarded owner commands cannot change routing", async () => {
  const start = daemon.indexOf("const handleOwnerCommand = (")
  const end = daemon.indexOf("const handleUpdateBody = (", start)
  assert.ok(start >= 0 && end > start)
  const command = runInNewContext(
    `${stripTypeScriptTypes(daemon.slice(start, end))}\n;handleOwnerCommand`,
    {
      Effect,
      telegramDirectOwnerText,
      selectAgent: () => assert.fail("forwarded quote executed a command"),
    },
  )
  const result = await Effect.runPromise(
    command(
      {},
      {
        message: {
          userId: 42,
          chatId: 42,
          messageId: 1,
          text: "/use worker",
          forwardOrigin: { speaker: "owner", userId: 42 },
        },
      },
    ),
  )
  assert.equal(result, false)
})

for (const forwarded of [false, true]) {
  test(`question answers use only direct owner text: forwarded=${forwarded}`, async () => {
    const start = daemon.indexOf("const handleQuestionReply = (")
    const end = daemon.indexOf("const ensureCabaSession = (", start)
    assert.ok(start >= 0 && end > start)
    let calls = 0
    const reply = runInNewContext(
      `${stripTypeScriptTypes(daemon.slice(start, end))}\n;handleQuestionReply`,
      { Effect, telegramDirectOwnerText },
    )
    const result = await Effect.runPromise(
      reply(
        {
          bridge: {
            answerTelegramQuestion: () => {
              calls++
              return Effect.succeed(undefined)
            },
          },
        },
        {
          message: {
            userId: 42,
            chatId: 42,
            messageId: 1,
            replyToMessageId: 100,
            text: "1",
            ...(forwarded
              ? { forwardOrigin: { speaker: "owner", userId: 42 } }
              : {}),
          },
        },
      ),
    )
    assert.equal(result, false)
    assert.equal(calls, forwarded ? 0 : 1)
  })
}

for (const text of ["/manager", "/use worker"]) {
  test(`control command cannot be consumed as a pending question answer: ${text}`, async () => {
    const start = daemon.indexOf("const handleQuestionReply = (")
    const end = daemon.indexOf("const ensureCabaSession = (", start)
    const reply = runInNewContext(
      `${stripTypeScriptTypes(daemon.slice(start, end))}\n;handleQuestionReply`,
      {
        Effect,
        telegramDirectOwnerText,
        availableAgents: () => Effect.succeed([]),
        sendText: () => Effect.void,
        emit: () => {},
      },
    )
    const result = await Effect.runPromise(
      reply(
        {
          bridge: {
            answerSolePendingTelegramQuestion: () =>
              Effect.succeed({ agentId: "worker", questionId: 7 }),
          },
        },
        { message: { userId: 42, chatId: 42, messageId: 1, text } },
      ),
    )
    assert.equal(result, false, "control commands must reach command handling")
  })
}
