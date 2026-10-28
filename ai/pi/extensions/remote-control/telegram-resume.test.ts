import assert from "node:assert/strict"
import { readFileSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { makeRemoteBridgeStore } from "./sqlite-store.ts"
import { resumeWorkers, resumeOutcomeText } from "./resume.ts"
import {
  createModelInputDelivery,
  type ModelInputDispatch,
  type DispatchDecision,
} from "../../host/model-input-delivery.ts"
import { registerOwnerAllowance } from "../classified-workflows/owner-allowance-extension.ts"
import { OWNER_ALLOWANCE_MS } from "../classified-workflows/owner-allowance.ts"
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent"
import { stripTypeScriptTypes } from "node:module"
import { runInNewContext } from "node:vm"
import test from "node:test"
import { HUMAN_TURN_EVENT } from "../shared/usage-governor-events.ts"
import { Deferred, Effect, Either, Ref } from "effect"
import {
  remoteMessageSource,
  remoteSourceCarriesOwnerAuthority,
  RemoteBridgeError,
} from "./protocol.ts"
import {
  telegramDirectOwnerText,
  telegramHasDirectOwnerInput,
  telegramOwnerConversationText,
  decodeTelegramOk,
} from "./telegram.ts"
import {
  TELEGRAM_RESUME_EVENT,
  TELEGRAM_RESUME_REQUEST,
  TELEGRAM_RESUME_TAG,
} from "../shared/telegram-resume.ts"

const relay = readFileSync(new URL("./piece-of-pi.ts", import.meta.url), "utf8")
const extension = readFileSync(new URL("./index.ts", import.meta.url), "utf8")

const extract = (source: string, start: string, end: string): string => {
  const first = source.indexOf(start)
  const last = source.indexOf(end, first)
  assert.ok(
    first >= 0 && last > first,
    `Missing runtime implementation: ${start}`,
  )
  return stripTypeScriptTypes(source.slice(first, last))
}

for (const ok of [false, true]) {
  test(`menu registration confirms /round only after Telegram accepts it: ok=${ok}`, async () => {
    const events: unknown[] = []
    const register = runInNewContext(
      `${extract(relay, "const registerTelegramCommands = (", "const sendTelegramMessage = (")}\n;registerTelegramCommands`,
      {
        Effect,
        decodeTelegramOk,
        telegramCall: (
          _configuration: unknown,
          method: string,
          body: { commands: { command: string }[] },
        ) => {
          assert.equal(method, "setMyCommands")
          assert.ok(body.commands.some(command => command.command === "round"))
          return Effect.succeed({ ok, result: true })
        },
        emit: (event: string, fields: unknown) => {
          events.push({ event, fields })
        },
      },
    )
    const result = await Effect.runPromise(
      Effect.either(register({ configuration: {} })),
    )
    assert.equal(Either.isRight(result), ok)
    assert.equal(events.length, ok ? 1 : 0)
    if (ok)
      assert.deepEqual(JSON.parse(JSON.stringify(events[0])), {
        event: "telegram_commands_registered",
        fields: { round: "all-live-workers" },
      })
  })
}

for (const forwarded of [false, true]) {
  test(`/round command uses authenticated native work delivery, forwarded=${forwarded}`, async () => {
    const queued: unknown[] = []
    const handle = runInNewContext(
      `${extract(relay, "const handleOwnerCommand = (", "const handleUpdateBody = (")}\n;handleOwnerCommand`,
      {
        Effect,
        telegramDirectOwnerText,
        TELEGRAM_RESUME_REQUEST,
        TELEGRAM_RESUME_TAG,
        resumeAllWorkers: (_runtime: unknown, update: unknown) => {
          queued.push(update)
          return Effect.void
        },
      },
    )
    const result = await Effect.runPromise(
      handle(
        {},
        {
          updateId: 1,
          message: {
            chatId: 42,
            messageId: 7,
            userId: 42,
            text: "/round",
            replyToMessageId: 6,
            ...(forwarded
              ? { forwardOrigin: { speaker: "owner", userId: 42 } }
              : {}),
          },
        },
      ),
    )
    assert.equal(result, !forwarded)
    assert.equal(queued.length, forwarded ? 0 : 1)
    if (!forwarded)
      assert.deepEqual(JSON.parse(JSON.stringify(queued[0])), {
        updateId: 1,
        message: {
          chatId: 42,
          messageId: 7,
          userId: 42,
          text: "/round",
          replyToMessageId: 6,
        },
      })
  })
}

for (const legacy of [false, true]) {
  for (const requesterId of [
    "telegram-owner-42",
    "telegram-forwarded-42",
    "bridge-peer",
  ]) {
    test(`native resume preserves tools and is owner-only: ${requesterId}, legacy=${legacy}`, async () => {
      const inputs: { text: string; options: unknown }[] = []
      const events: { name: string; payload: unknown }[] = []
      const completed: unknown[] = []
      const resume = runInNewContext(
        `${extract(extension, "  const resumeOwnerWork = async (", "  const beginTurn = async (")}\n;resumeOwnerWork`,
        {
          Effect,
          Either,
          RemoteBridgeError,
          TELEGRAM_RESUME_REQUEST,
          TELEGRAM_RESUME_TAG,
          TELEGRAM_RESUME_EVENT,
          HUMAN_TURN_EVENT,
          remoteMessageSource,
          remoteSourceCarriesOwnerAuthority,
          options: {
            authorizeOwnerInput: () => ({ ok: true, value: undefined }),
          },
          run: (operation: Effect.Effect<unknown, unknown>) =>
            Effect.runPromise(Effect.either(operation)),
          pi: {
            registerModelInputDeliveryGuard: () => {},
            sendUserMessage: (
              text: string,
              options: { authorizeInput: (id: string) => unknown },
            ) => {
              inputs.push({ text, options })
              options.authorizeInput("native-receipt")
            },
            events: {
              emit: (name: string, payload: unknown) => {
                events.push({ name, payload })
              },
            },
            setActiveTools: () =>
              assert.fail(
                "resume must not disable or replace the current tools",
              ),
          },
          store: {
            complete: (value: unknown) => {
              completed.push(value)
              return Effect.succeed({})
            },
            fail: () => Effect.succeed({}),
          },
          onAuthenticatedOwnerMessage: undefined,
          safeError: () => "error",
          STATUS_KEY: "test",
        },
      )
      const result = await resume(
        {
          id: "request",
          claimToken: "claim",
          requesterId,
          text: legacy
            ? `${TELEGRAM_RESUME_TAG}Prior instruction text`
            : TELEGRAM_RESUME_REQUEST,
          createdAt: 10,
        },
        {
          cwd: "/work/project",
          sessionManager: { getSessionId: () => "session-1" },
          ui: { setStatus: () => {}, notify: () => {} },
        },
      )
      const owner = requesterId === "telegram-owner-42"
      assert.equal(result, owner)
      assert.equal(inputs.length, owner ? 1 : 0)
      assert.equal(events.length, owner ? 2 : 0)
      assert.equal(completed.length, owner ? 1 : 0)
      if (owner) {
        assert.equal(events[0]?.name, HUMAN_TURN_EVENT)
        assert.equal(events[0]?.payload, TELEGRAM_RESUME_REQUEST)
        assert.equal(inputs[0]?.text, TELEGRAM_RESUME_REQUEST)
        assert.equal(
          typeof (inputs[0]?.options as { authorizeInput?: unknown })
            .authorizeInput,
          "function",
        )
        assert.deepEqual(JSON.parse(JSON.stringify(events[1])), {
          name: TELEGRAM_RESUME_EVENT,
          payload: { sessionId: "session-1" },
        })
      }
    })
  }
}

test("resume prompt names task inspection, ranked active work and ask_user without negative clauses", () => {
  assert.match(TELEGRAM_RESUME_REQUEST, /task list/i)
  assert.match(TELEGRAM_RESUME_REQUEST, /highest-ranked.*active.*authorized/i)
  assert.match(TELEGRAM_RESUME_REQUEST, /ask_user/)
  assert.doesNotMatch(TELEGRAM_RESUME_REQUEST, /\bdo not\b/i)
})

for (const mode of ["denied", "missing-authority", "unsupported-host"]) {
  test(`resume fails closed without native owner-input authorization: ${mode}`, async () => {
    const failures: unknown[] = []
    const resume = runInNewContext(
      `${extract(extension, "  const resumeOwnerWork = async (", "  const beginTurn = async (")}\n;resumeOwnerWork`,
      {
        Effect,
        Either,
        RemoteBridgeError,
        TELEGRAM_RESUME_REQUEST,
        TELEGRAM_RESUME_TAG,
        TELEGRAM_RESUME_EVENT,
        HUMAN_TURN_EVENT,
        remoteMessageSource,
        remoteSourceCarriesOwnerAuthority,
        STATUS_KEY: "test",
        safeError: () => "error",
        onAuthenticatedOwnerMessage: undefined,
        options:
          mode === "missing-authority"
            ? {}
            : {
                authorizeOwnerInput: () => ({
                  ok: false,
                  error: { code: "denied", message: "Denied" },
                }),
              },
        pi: {
          registerModelInputDeliveryGuard:
            mode === "unsupported-host" ? undefined : () => {},
          sendUserMessage: (
            _text: string,
            options: { authorizeInput: (id: string) => { ok: boolean } },
          ) => {
            assert.equal(mode, "denied")
            assert.equal(options.authorizeInput("receipt").ok, false)
          },
          events: {
            emit: () =>
              assert.fail("denied resume must not unpause continuation"),
          },
          setActiveTools: () =>
            assert.fail("denied resume must preserve tools"),
        },
        run: (operation: Effect.Effect<unknown, unknown>) =>
          Effect.runPromise(Effect.either(operation)),
        store: {
          complete: () =>
            assert.fail("denied resume must not acknowledge delivery"),
          fail: (value: unknown) => {
            failures.push(value)
            return Effect.succeed({})
          },
        },
      },
    )
    await resume(
      {
        id: "request",
        claimToken: "claim",
        requesterId: "telegram-owner-42",
        text: TELEGRAM_RESUME_REQUEST,
      },
      { ui: { setStatus: () => {} } },
    )
    assert.equal(failures.length, 1)
  })
}

test("installed legacy host resumes through its existing private owner-input callback", async t => {
  const inputs: string[] = []
  const completed: unknown[] = []
  const ownerTurns: string[] = []
  const pi = {
    on: () => {},
    registerCommand: () => {},
    appendEntry: () => {},
    events: {
      emit: (name: string) => {
        ownerTurns.push(name)
      },
    },
    sendUserMessage: (text: string) => {
      inputs.push(text)
    },
  }
  const guard = registerOwnerAllowance(pi as unknown as ExtensionAPI, () => {})
  t.after(() => guard.dispose())
  assert.equal(guard.timing, "legacy-input")
  assert.equal(Either.isLeft(guard.admit()), true)
  const before = Date.now()
  const resume = runInNewContext(
    `${extract(extension, "  const resumeOwnerWork = async (", "  const beginTurn = async (")}\n;resumeOwnerWork`,
    {
      Effect,
      Either,
      RemoteBridgeError,
      TELEGRAM_RESUME_REQUEST,
      TELEGRAM_RESUME_TAG,
      TELEGRAM_RESUME_EVENT,
      HUMAN_TURN_EVENT,
      remoteMessageSource,
      remoteSourceCarriesOwnerAuthority,
      pi,
      STATUS_KEY: "test",
      safeError: () => "error",
      options: { reporting: { execution: guard } },
      onAuthenticatedOwnerMessage: (receivedAt: number) => {
        guard.ownerInput(receivedAt)
      },
      run: (operation: Effect.Effect<unknown, unknown>) =>
        Effect.runPromise(Effect.either(operation)),
      store: {
        complete: (value: unknown) => {
          completed.push(value)
          return Effect.succeed({})
        },
        fail: () => Effect.succeed({}),
      },
    },
  )
  await resume(
    {
      id: "request",
      claimToken: "claim",
      requesterId: "telegram-owner-42",
      text: TELEGRAM_RESUME_REQUEST,
    },
    {
      cwd: "/work/legacy",
      sessionManager: { getSessionId: () => "legacy" },
      ui: { setStatus: () => {} },
    },
  )
  assert.deepEqual(inputs, [TELEGRAM_RESUME_REQUEST])
  assert.deepEqual(ownerTurns, [HUMAN_TURN_EVENT, TELEGRAM_RESUME_EVENT])
  assert.equal(completed.length, 1)
  const admitted = guard.admit()
  assert.equal(Either.isRight(admitted), true)
  if (Either.isLeft(admitted)) return assert.fail(admitted.left.message)
  assert.ok(admitted.right.lastOwnerAt >= before)
  assert.equal(
    admitted.right.deadlineAt - admitted.right.lastOwnerAt,
    OWNER_ALLOWANCE_MS,
  )
})

test("a denied native resume records a real bridge failure rather than stranding its claim", async t => {
  const root = mkdtempSync(join(tmpdir(), "pi-telegram-resume-denied-"))
  t.after(() => rmSync(root, { recursive: true }))
  const store = makeRemoteBridgeStore(join(root, "bridge.sqlite"))
  const now = Date.now()
  await Effect.runPromise(
    store.heartbeatAgent({
      id: "worker",
      label: "Worker",
      cwd: "/worker",
      accepting: true,
      workDelivery: "native-pi",
      now,
      ttlMs: 60000,
    }),
  )
  const message = await Effect.runPromise(
    store.enqueue({
      targetAgentId: "worker",
      requesterId: "telegram-owner-42",
      dedupeKey: "denied",
      text: TELEGRAM_RESUME_REQUEST,
      now,
      ttlMs: 60000,
    }),
  )
  const claimed = await Effect.runPromise(
    store.claimNext({ agentId: "worker", now }),
  )
  assert.equal(claimed?.status, "claimed")
  const resume = runInNewContext(
    `${extract(extension, "  const resumeOwnerWork = async (", "  const beginTurn = async (")}\n;resumeOwnerWork`,
    {
      Effect,
      Either,
      RemoteBridgeError,
      TELEGRAM_RESUME_REQUEST,
      TELEGRAM_RESUME_TAG,
      TELEGRAM_RESUME_EVENT,
      HUMAN_TURN_EVENT,
      remoteMessageSource,
      remoteSourceCarriesOwnerAuthority,
      options: {},
      pi: { registerModelInputDeliveryGuard: () => {} },
      store,
      STATUS_KEY: "test",
      safeError: () => "error",
      run: (operation: Effect.Effect<unknown, unknown>) =>
        Effect.runPromise(Effect.either(operation)),
    },
  )
  await resume(claimed, { ui: { setStatus: () => {} } })
  const failed = await Effect.runPromise(store.get(message.id, Date.now()))
  assert.equal(failed.status, "failed")
  if (failed.status !== "failed")
    return assert.fail("denied resume remained claimed")
  assert.equal(failed.failure, "model_error")
})

test("resume renews the existing allowance only at actual native owner-input dispatch", async t => {
  const now = Date.now()
  let id = 0
  const delivery = createModelInputDelivery({
    now: () => now,
    newId: () => `native-${++id}`,
  })
  const context = {
    cwd: "/work/native",
    sessionManager: { getSessionId: () => "native-session" },
    ui: { setStatus: () => {}, notify: () => {} },
    abort: () => {},
  }
  const pi = {
    on: () => {},
    registerCommand: () => {},
    appendEntry: () => {},
    registerModelInputDeliveryGuard: (
      handler: (
        dispatch: ModelInputDispatch,
        ctx: ExtensionContext,
      ) => DispatchDecision,
    ) =>
      delivery.registerGuard("classified-workflows", dispatch =>
        handler(dispatch, context as unknown as ExtensionContext),
      ),
    events: { emit: () => {} },
    sendUserMessage: (
      text: string,
      options: { authorizeInput: (id: string) => { ok: boolean } },
    ) => {
      const accepted = delivery.acceptInput("extension")
      assert.equal(accepted.ok, true)
      const input = { role: "user", content: text }
      assert.equal(delivery.associate(accepted.value, input, false).ok, true)
      assert.equal(options.authorizeInput(accepted.value.id).ok, true)
      assert.equal(
        Either.isLeft(guard.admit()),
        true,
        "receipt association alone must not renew allowance",
      )
      assert.equal(delivery.dispatch([input], () => undefined).ok, true)
    },
  }
  const guard = registerOwnerAllowance(pi as unknown as ExtensionAPI, () => {})
  t.after(() => guard.dispose())
  assert.equal(Either.isLeft(guard.admit()), true)
  const resume = runInNewContext(
    `${extract(extension, "  const resumeOwnerWork = async (", "  const beginTurn = async (")}\n;resumeOwnerWork`,
    {
      Effect,
      Either,
      RemoteBridgeError,
      TELEGRAM_RESUME_REQUEST,
      TELEGRAM_RESUME_TAG,
      TELEGRAM_RESUME_EVENT,
      HUMAN_TURN_EVENT,
      remoteMessageSource,
      remoteSourceCarriesOwnerAuthority,
      pi,
      options: { authorizeOwnerInput: guard.inputDelivery?.authorizeInput },
      STATUS_KEY: "test",
      safeError: () => "error",
      run: (operation: Effect.Effect<unknown, unknown>) =>
        Effect.runPromise(Effect.either(operation)),
      store: {
        complete: () => Effect.succeed({}),
        fail: () => {
          assert.fail("native resume delivery failed")
        },
      },
    },
  )
  assert.equal(
    await resume(
      {
        id: "request",
        claimToken: "claim",
        requesterId: "telegram-owner-42",
        text: TELEGRAM_RESUME_REQUEST,
      },
      context,
    ),
    true,
  )
  const admitted = guard.admit()
  assert.equal(Either.isRight(admitted), true)
  if (Either.isLeft(admitted)) return assert.fail(admitted.left.message)
  assert.equal(admitted.right.lastOwnerAt, now)
  assert.equal(admitted.right.deadlineAt, now + OWNER_ALLOWANCE_MS)
})

test("resume discovery can inspect expired roster entries without treating them as alive", async t => {
  const root = mkdtempSync(join(tmpdir(), "pi-telegram-resume-"))
  t.after(() => rmSync(root, { recursive: true }))
  const store = makeRemoteBridgeStore(join(root, "bridge.sqlite"))
  await Effect.runPromise(
    store.heartbeatAgent({
      id: "dead",
      label: "Dead",
      cwd: "/dead",
      accepting: true,
      workDelivery: "native-pi",
      now: 1000,
      ttlMs: 1000,
    }),
  )
  await Effect.runPromise(
    store.heartbeatAgent({
      id: "live",
      label: "Live",
      cwd: "/live",
      accepting: true,
      workDelivery: "native-pi",
      now: 3000,
      ttlMs: 1000,
    }),
  )
  const known = await Effect.runPromise(
    store.listAgents(3000, { includeExpired: true }),
  )
  assert.deepEqual(
    known.map(agent => agent.id),
    ["dead", "live"],
  )
  assert.deepEqual(
    (await Effect.runPromise(store.listAgents(3000))).map(agent => agent.id),
    ["live"],
  )
  assert.equal(
    (await Effect.runPromise(store.listAgents(3000, { includeExpired: true })))
      .length,
    2,
  )
})

test("retained dead-worker reporting remains bounded and cannot prevent new worker heartbeats", async t => {
  const root = mkdtempSync(join(tmpdir(), "pi-telegram-resume-capacity-"))
  t.after(() => rmSync(root, { recursive: true }))
  const path = join(root, "bridge.sqlite")
  const store = makeRemoteBridgeStore(path)
  await Effect.runPromise(
    store.heartbeatAgent({
      id: "oldest",
      label: "Oldest",
      cwd: "/oldest",
      accepting: true,
      workDelivery: "native-pi",
      now: 0,
      ttlMs: 1000,
    }),
  )
  const database = new DatabaseSync(path)
  try {
    database.exec("BEGIN")
    const insert = database.prepare(
      "INSERT INTO bridge_agents (agent_id, label, cwd, heartbeat_at, expires_at, accepting, work_delivery) VALUES (?, 'Past worker', '/past', 1000, 2000, 1, 'native-pi')",
    )
    for (let index = 0; index < 1023; index++) insert.run(`past-${index}`)
    database.exec("COMMIT")
  } finally {
    database.close()
  }
  await Effect.runPromise(
    store.heartbeatAgent({
      id: "fresh",
      label: "Fresh",
      cwd: "/fresh",
      accepting: true,
      workDelivery: "native-pi",
      now: 3000,
      ttlMs: 1000,
    }),
  )
  const known = await Effect.runPromise(
    store.listAgents(3000, { includeExpired: true }),
  )
  assert.equal(known.length, 1024)
  assert.equal(
    known.some(agent => agent.id === "oldest"),
    false,
  )
  assert.equal(
    known.some(agent => agent.id === "fresh"),
    true,
  )
  assert.deepEqual(
    (await Effect.runPromise(store.listAgents(3000))).map(agent => agent.id),
    ["fresh"],
  )
  const full = new DatabaseSync(path)
  try {
    full.exec("UPDATE bridge_agents SET heartbeat_at = 3000, expires_at = 6000")
  } finally {
    full.close()
  }
  const rejected = await Effect.runPromise(
    Effect.either(
      store.heartbeatAgent({
        id: "overflow",
        label: "Overflow",
        cwd: "/overflow",
        accepting: true,
        workDelivery: "native-pi",
        now: 3500,
        ttlMs: 1000,
      }),
    ),
  )
  assert.equal(Either.isLeft(rejected), true)
  if (Either.isRight(rejected))
    return assert.fail("a full live roster must retain its capacity guard")
  assert.equal(rejected.left.code, "capacity")
  assert.equal((await Effect.runPromise(store.listAgents(3500))).length, 1024)
})

test("actual resume enqueue preserves the marker and feedback, with independent per-worker deduplication", async t => {
  const root = mkdtempSync(join(tmpdir(), "pi-telegram-resume-enqueue-"))
  t.after(() => rmSync(root, { recursive: true }))
  const store = makeRemoteBridgeStore(join(root, "bridge.sqlite"))
  const now = Date.now()
  const workers = await Effect.runPromise(
    Effect.forEach(["a", "b"], id =>
      store.heartbeatAgent({
        id,
        label: id,
        cwd: `/work/${id}`,
        accepting: true,
        workDelivery: "native-pi",
        now,
        ttlMs: 60000,
      }),
    ),
  )
  let cleared = 0
  const state = Effect.runSync(
    Ref.make({
      pendingReactionFeedback: ["A previous reply received a reaction."],
    }),
  )
  const enqueue = runInNewContext(
    `${extract(relay, "const enqueueOwnerMessage = (", "const selectAgent = (")}\n;enqueueOwnerMessage`,
    {
      Effect,
      Ref,
      TELEGRAM_RESUME_REQUEST,
      TELEGRAM_RESUME_TAG,
      telegramHasDirectOwnerInput,
      telegramOwnerConversationText,
      sendTelegramAction: () => Effect.void,
      chooseAgent: () =>
        assert.fail("resume must not select manager/default target"),
      clearPendingReactionFeedback: () => {
        cleared++
        return Effect.void
      },
      BRIDGE_MESSAGE_TTL_MS: 60000,
      BRIDGE_TYPING_REFRESH_MS: 5000,
      awaitBridgeResult: () => Effect.void,
    },
  )
  const update = {
    updateId: 99,
    message: {
      chatId: 42,
      messageId: 7,
      userId: 42,
      text: TELEGRAM_RESUME_REQUEST,
    },
  }
  for (let repeat = 0; repeat < 2; repeat++)
    for (const worker of workers)
      await Effect.runPromise(enqueue({ state, bridge: store }, update, worker))
  assert.equal(
    cleared,
    0,
    "resume must not consume unrelated reaction feedback",
  )
  await Effect.runPromise(
    resumeWorkers(store, {
      requesterId: "telegram-owner-42",
      invocationId: String(update.updateId),
    }),
  )
  for (const agent of await Effect.runPromise(store.listAgents(Date.now())))
    assert.equal(
      agent.queuedMessages,
      1,
      "shared action must preserve legacy per-update Telegram dedupe keys",
    )
  for (const worker of workers) {
    const claimed = await Effect.runPromise(
      store.claimNext({ agentId: worker.id, now: Date.now() }),
    )
    assert.equal(claimed?.text, TELEGRAM_RESUME_REQUEST)
    assert.equal(claimed?.requesterId, "telegram-owner-42")
    assert.equal(
      (await Effect.runPromise(store.listAgents(Date.now()))).find(
        agent => agent.id === worker.id,
      )?.queuedMessages,
      0,
    )
    assert.equal(claimed?.status, "claimed")
    if (claimed?.status !== "claimed")
      return assert.fail("resume message was not claimed")
    await Effect.runPromise(
      store.complete({
        messageId: claimed.id,
        claimToken: claimed.claimToken,
        response: "Input accepted",
        now: Date.now(),
      }),
    )
    const duplicate = await Effect.runPromise(
      enqueue({ state, bridge: store }, update, worker),
    )
    assert.ok(typeof duplicate === "object" && duplicate !== null)
    assert.equal(Reflect.get(duplicate, "status"), "completed")
  }
})

for (const failWatcher of [false, true]) {
  test(`bare /round routes worker results and watcher notifications: failure=${failWatcher}`, async () => {
    const queued: { id: string; text: string; requesterId: string }[] = []
    const watched: { chatId: number; replyId: number; messageId: string }[] = []
    const replies: string[] = []
    const watchersStarted = await Effect.runPromise(Deferred.make<void>())
    const failureNotified = await Effect.runPromise(Deferred.make<void>())
    const startedAt = Date.now()
    const enqueue = (input: {
      targetAgentId: string
      text: string
      requesterId: string
    }) => {
      queued.push({
        id: input.targetAgentId,
        text: input.text,
        requesterId: input.requesterId,
      })
      if (input.targetAgentId === "worker-b")
        return Effect.fail(
          new RemoteBridgeError({
            code: "io",
            message: "fixture delivery failure",
          }),
        )
      return Effect.succeed(
        input.targetAgentId === "failed"
          ? {
              id: `message-${input.targetAgentId}`,
              status: "failed",
              failure: "expired",
            }
          : {
              id: `message-${input.targetAgentId}`,
              status:
                input.targetAgentId === "worker-a"
                  ? "completed"
                  : input.targetAgentId === "queued"
                    ? "queued"
                    : "claimed",
            },
      )
    }
    const resume = runInNewContext(
      `${extract(relay, "const resumeAllWorkers = (", "const handleOwnerCommand = (")}\n;resumeAllWorkers`,
      {
        Effect,
        TELEGRAM_RESUME_REQUEST,
        TELEGRAM_RESUME_TAG,
        resumeWorkers,
        resumeOutcomeText,
        awaitBridgeResult: (
          _runtime: unknown,
          chatId: number,
          replyId: number,
          messageId: string,
          state: { nextTypingAt: number },
        ) =>
          Effect.gen(function* () {
            watched.push({ chatId, replyId, messageId })
            assert.ok(state.nextTypingAt >= startedAt + 5000)
            if (watched.length === 3)
              yield* Deferred.succeed(watchersStarted, undefined)
            if (failWatcher && messageId === "message-busy")
              return yield* Effect.fail(
                new RemoteBridgeError({
                  code: "io",
                  message: "fixture watcher failure",
                }),
              )
          }),
        BRIDGE_TYPING_REFRESH_MS: 5000,
        sendText: (
          _runtime: unknown,
          chatId: number,
          text: string,
          replyId: number,
        ) => {
          assert.equal(chatId, 42)
          assert.equal(replyId, 9)
          replies.push(text)
          return text.startsWith("Round response could not be delivered:")
            ? Deferred.succeed(failureNotified, undefined)
            : Effect.void
        },
      },
    )
    await Effect.runPromise(
      resume(
        {
          bridge: {
            enqueue,
            listAgents: (_now: number, options: unknown) => {
              assert.equal(
                JSON.stringify(options),
                JSON.stringify({ includeExpired: true }),
              )
              return Effect.succeed([
                {
                  id: "worker-a",
                  label: "A",
                  cwd: "/work/a",
                  accepting: true,
                  workDelivery: "native-pi",
                  expiresAt: Number.MAX_SAFE_INTEGER,
                },
                {
                  id: "worker-b",
                  label: "B",
                  cwd: "/work/b",
                  accepting: true,
                  workDelivery: "native-pi",
                  expiresAt: Number.MAX_SAFE_INTEGER,
                },
                {
                  id: "busy",
                  label: "Busy",
                  cwd: "/work/busy",
                  accepting: false,
                  workDelivery: "native-pi",
                  expiresAt: Number.MAX_SAFE_INTEGER,
                },
                {
                  id: "queued",
                  label: "Queue",
                  cwd: "/work/queued",
                  accepting: true,
                  workDelivery: "native-pi",
                  expiresAt: Number.MAX_SAFE_INTEGER,
                },
                {
                  id: "failed",
                  label: "Failed",
                  cwd: "/work/failed",
                  accepting: true,
                  workDelivery: "native-pi",
                  expiresAt: Number.MAX_SAFE_INTEGER,
                },
                {
                  id: "dead",
                  label: "Dead",
                  cwd: "/work/dead",
                  accepting: true,
                  workDelivery: "native-pi",
                  expiresAt: 0,
                },
                {
                  id: "manager",
                  label: "Manager",
                  nativeManager: true,
                  accepting: true,
                  workDelivery: "native-pi",
                  expiresAt: Number.MAX_SAFE_INTEGER,
                },
              ])
            },
          },
        },
        {
          updateId: 99,
          message: { chatId: 42, messageId: 9, userId: 42, text: "/round" },
        },
      ),
    )
    await Effect.runPromise(
      Deferred.await(watchersStarted).pipe(Effect.timeout("1 second")),
    )
    if (failWatcher)
      await Effect.runPromise(
        Deferred.await(failureNotified).pipe(Effect.timeout("1 second")),
      )
    assert.deepEqual(watched, [
      { chatId: 42, replyId: 9, messageId: "message-worker-a" },
      { chatId: 42, replyId: 9, messageId: "message-busy" },
      { chatId: 42, replyId: 9, messageId: "message-queued" },
    ])
    const failureReplies = replies.filter(text =>
      text.startsWith("Round response could not be delivered:"),
    )
    assert.deepEqual(
      failureReplies,
      failWatcher
        ? [
            "Round response could not be delivered: Busy · /work/busy · session busy.",
          ]
        : [],
    )
    const reply = replies.find(text => text.includes("Input already accepted:"))
    assert.ok(reply)
    assert.deepEqual(
      queued.map(item => item.id),
      ["worker-a", "worker-b", "busy", "queued", "failed"],
    )
    for (const item of queued) {
      assert.equal(item.text, TELEGRAM_RESUME_REQUEST)
      assert.equal(item.requesterId, "telegram-owner-42")
    }
    assert.match(
      reply,
      /Input already accepted: A · \/work\/a · session worker-a/,
    )
    assert.match(reply, /Delivering: Busy · \/work\/busy · session busy/)
    assert.match(reply, /Queued: Queue · \/work\/queued · session queued/)
    assert.match(
      reply,
      /Skipped \(expired\): Failed · \/work\/failed · session failed/,
    )
    assert.match(reply, /worker-b/)
    assert.match(reply, /dead/)
    assert.match(reply, /Skipped \(io\): B · \/work\/b · session worker-b/)
    assert.match(
      reply,
      /Skipped \(offline or unavailable\): Dead · \/work\/dead · session dead/,
    )
  })
}

test("native resume releases only the matching session's continuation pause", () => {
  const source = readFileSync(
    new URL("../classified-workflows/index.ts", import.meta.url),
    "utf8",
  )
  let handler: (value: unknown) => void = () =>
    assert.fail("resume listener not registered")
  const unpaused: unknown[] = []
  const ctx = { sessionManager: { getSessionId: () => "worker-a" } }
  runInNewContext(
    extract(
      source,
      "  pi.events.on(TELEGRAM_RESUME_EVENT,",
      "  pi.events.on(REMOTE_CAPABILITY_HANDSHAKE_EVENT,",
    ),
    {
      pi: {
        events: {
          on: (_name: string, callback: (value: unknown) => void) => {
            handler = callback
          },
        },
      },
      TELEGRAM_RESUME_EVENT,
      HUMAN_TURN_EVENT,
      latestCtx: ctx,
      continuationPaused: true,
      isRecord: (value: unknown) =>
        typeof value === "object" && value !== null && !Array.isArray(value),
      setContinuationPaused: (paused: boolean, context: unknown) => {
        assert.equal(paused, false)
        assert.equal(context, ctx)
        unpaused.push(context)
      },
      rejectWorkflowEvent: () => {},
    },
  )
  handler({ sessionId: "other" })
  handler(null)
  assert.equal(unpaused.length, 0)
  handler({ sessionId: "worker-a" })
  assert.equal(unpaused.length, 1)
})

test("resume is registered in Telegram's command menu and bypasses question-answer consumption", () => {
  assert.match(
    extension,
    /registerRuntimeVersion\(pi, "owner-resume-input", "2026\.10\.24\.2"\)/,
  )
  assert.match(
    readFileSync(
      new URL("../classified-workflows/index.ts", import.meta.url),
      "utf8",
    ),
    /registerRuntimeVersion\(pi, "owner-resume-continuation", "2026\.10\.24\.1"\)/,
  )
  assert.match(relay, /command: "round"/)
  const question = extract(
    relay,
    "const handleQuestionReply = (",
    "const ensureCabaSession = (",
  )
  assert.match(question, /answer === "\/round"/)
  assert.match(extension, /resumeOwnerWork\(message, ctx\)/)
  assert.match(extension, /resumeOwnerWork\(claimed\.right, ctx\)/)
})
