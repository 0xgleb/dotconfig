#!/usr/bin/env node
import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as Either from "effect/Either"
import * as Ref from "effect/Ref"

import {
  agentListHtml,
  agentMatchesSelector,
  preferredAgent,
} from "./agent-selection.ts"
import { remoteBridgeDatabasePath } from "./paths.ts"
import {
  BRIDGE_MESSAGE_TTL_MS,
  type BridgeAgent,
  type BridgeQuestion,
  type RemoteBridgeError,
} from "./protocol.ts"
import { makeRemoteBridgeStore } from "./sqlite-store.ts"
import {
  authorizeTelegramMessage,
  decodeTelegramSentMessageId,
  decodeTelegramUpdates,
  freshClankerRejection,
  type TelegramBotState,
  type TelegramContractError,
  type TelegramUpdate,
} from "./telegram.ts"

const TELEGRAM_LONG_POLL_SECONDS = 25
const TELEGRAM_MESSAGE_LIMIT = 4_000
const BRIDGE_RESULT_POLL_INTERVAL = "1 second"
const POLL_RETRY_INTERVAL = "2 seconds"

interface PieceOfPiState extends TelegramBotState {
  readonly nextUpdateId?: number
  readonly rejectionCounter: number
  readonly selectedAgentId?: string
  readonly ownerChatId?: number
}

interface PieceOfPiConfiguration {
  readonly ownerUsername: string
  readonly token: string
  readonly statePath: string
}

interface PieceOfPiRuntime {
  readonly configuration: PieceOfPiConfiguration
  readonly state: Ref.Ref<PieceOfPiState>
  readonly bridge: ReturnType<typeof makeRemoteBridgeStore>
}

type PieceOfPiEvent =
  | "service_ready"
  | "poll_failed"
  | "sender_rejected"
  | "bridge_completed"
  | "bridge_failed"
  | "question_relayed"
  | "question_answered"

export type PieceOfPiConfigurationErrorCode =
  | "missing_token_file_environment"
  | "missing_owner_environment"
  | "token_file_unreadable"
  | "token_shape_invalid"

export class PieceOfPiConfigurationError extends Data.TaggedError(
  "PieceOfPiConfigurationError",
)<{
  readonly code: PieceOfPiConfigurationErrorCode
  readonly message: string
}> {}

export class PieceOfPiStateError extends Data.TaggedError(
  "PieceOfPiStateError",
)<{ readonly message: string }> {}

export class TelegramTransportError extends Data.TaggedError(
  "TelegramTransportError",
)<{ readonly method: string; readonly message: string }> {}

const emit = (
  event: PieceOfPiEvent,
  fields: Readonly<Record<string, string | number>> = {},
): void => {
  const level =
    event === "poll_failed" || event === "bridge_failed" ? "error" : "info"
  process.stdout.write(`${JSON.stringify({ level, event, ...fields })}\n`)
}

const requiredEnvironment = (
  name: string,
  code: PieceOfPiConfigurationErrorCode,
): Effect.Effect<string, PieceOfPiConfigurationError> => {
  const configured = process.env[name]?.trim()

  return configured
    ? Effect.succeed(configured)
    : Effect.fail(
        new PieceOfPiConfigurationError({
          code,
          message: `${name} is required`,
        }),
      )
}

const loadConfiguration = Effect.gen(function* () {
  const tokenFile = yield* requiredEnvironment(
    "PIECE_OF_PI_TELEGRAM_TOKEN_FILE",
    "missing_token_file_environment",
  )
  const ownerUsername = yield* requiredEnvironment(
    "PIECE_OF_PI_TELEGRAM_OWNER_USERNAME",
    "missing_owner_environment",
  )
  const token = yield* Effect.tryPromise({
    try: () => readFile(tokenFile, "utf8").then((contents) => contents.trim()),
    catch: () =>
      new PieceOfPiConfigurationError({
        code: "token_file_unreadable",
        message: "Telegram token file could not be read",
      }),
  })
  if (!/^\d+:[A-Za-z0-9_-]+$/.test(token)) {
    return yield* Effect.fail(
      new PieceOfPiConfigurationError({
        code: "token_shape_invalid",
        message: "Telegram token has an invalid shape",
      }),
    )
  }
  const stateRoot =
    process.env.XDG_STATE_HOME?.trim() || join(homedir(), ".local", "state")
  return {
    ownerUsername: ownerUsername.replace(/^@/, "").toLowerCase(),
    token,
    statePath: join(stateRoot, "pi", "piece-of-pi-telegram.json"),
  } satisfies PieceOfPiConfiguration
})

const decodeState = (
  input: unknown,
): Effect.Effect<PieceOfPiState, PieceOfPiStateError> => {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return Effect.fail(
      new PieceOfPiStateError({
        message: "Piece of Pi state must be an object",
      }),
    )
  }
  const candidate = input as Readonly<Record<string, unknown>>
  if (
    !Number.isSafeInteger(candidate.rejectionCounter) ||
    Number(candidate.rejectionCounter) < 0
  ) {
    return Effect.fail(
      new PieceOfPiStateError({
        message: "Piece of Pi rejection counter is invalid",
      }),
    )
  }
  if (
    candidate.ownerUserId !== undefined &&
    !Number.isSafeInteger(candidate.ownerUserId)
  ) {
    return Effect.fail(
      new PieceOfPiStateError({ message: "Piece of Pi owner ID is invalid" }),
    )
  }
  if (
    candidate.nextUpdateId !== undefined &&
    !Number.isSafeInteger(candidate.nextUpdateId)
  ) {
    return Effect.fail(
      new PieceOfPiStateError({
        message: "Piece of Pi update offset is invalid",
      }),
    )
  }
  if (
    candidate.selectedAgentId !== undefined &&
    typeof candidate.selectedAgentId !== "string"
  ) {
    return Effect.fail(
      new PieceOfPiStateError({
        message: "Piece of Pi selected agent is invalid",
      }),
    )
  }
  if (
    candidate.ownerChatId !== undefined &&
    !Number.isSafeInteger(candidate.ownerChatId)
  ) {
    return Effect.fail(
      new PieceOfPiStateError({ message: "Piece of Pi owner chat is invalid" }),
    )
  }
  return Effect.succeed({
    rejectionCounter: Number(candidate.rejectionCounter),
    ...(typeof candidate.ownerUserId === "number"
      ? { ownerUserId: candidate.ownerUserId }
      : {}),
    ...(typeof candidate.nextUpdateId === "number"
      ? { nextUpdateId: candidate.nextUpdateId }
      : {}),
    ...(typeof candidate.selectedAgentId === "string"
      ? { selectedAgentId: candidate.selectedAgentId }
      : {}),
    ...(typeof candidate.ownerChatId === "number"
      ? { ownerChatId: candidate.ownerChatId }
      : {}),
  })
}

const loadState = (
  statePath: string,
): Effect.Effect<PieceOfPiState, PieceOfPiStateError> =>
  Effect.tryPromise({
    try: () => readFile(statePath, "utf8"),
    catch: (error) => error,
  }).pipe(
    Effect.flatMap((contents) =>
      Effect.try({
        try: () => JSON.parse(contents) as unknown,
        catch: () =>
          new PieceOfPiStateError({
            message: "Piece of Pi state is not valid JSON",
          }),
      }),
    ),
    Effect.flatMap(decodeState),
    Effect.catchAll((error) =>
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
        ? Effect.succeed({ rejectionCounter: 0 })
        : Effect.fail(
            error instanceof PieceOfPiStateError
              ? error
              : new PieceOfPiStateError({
                  message: "Piece of Pi state could not be read",
                }),
          ),
    ),
  )

const persistState = (
  statePath: string,
  state: PieceOfPiState,
): Effect.Effect<void, PieceOfPiStateError> =>
  Effect.tryPromise({
    try: async () => {
      await mkdir(dirname(statePath), { recursive: true, mode: 0o700 })
      const temporaryPath = `${statePath}.tmp`
      await writeFile(temporaryPath, `${JSON.stringify(state)}\n`, {
        mode: 0o600,
      })
      await rename(temporaryPath, statePath)
    },
    catch: () =>
      new PieceOfPiStateError({
        message: "Piece of Pi state could not be persisted",
      }),
  })

const telegramCall = (
  configuration: PieceOfPiConfiguration,
  method: string,
  body: Readonly<Record<string, unknown>>,
): Effect.Effect<unknown, TelegramTransportError> =>
  Effect.tryPromise({
    try: async () => {
      const response = await fetch(
        `https://api.telegram.org/bot${configuration.token}/${method}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        },
      )
      if (!response.ok) throw new Error("Telegram HTTP request failed")
      return (await response.json()) as unknown
    },
    catch: () =>
      new TelegramTransportError({
        method,
        message: `Telegram ${method} request failed`,
      }),
  })

const sendTelegramMessage = (
  runtime: PieceOfPiRuntime,
  chatId: number,
  text: string,
  replyToMessageId?: number,
  parseMode?: "HTML",
): Effect.Effect<number, TelegramTransportError | TelegramContractError> =>
  telegramCall(runtime.configuration, "sendMessage", {
    chat_id: chatId,
    text,
    ...(replyToMessageId !== undefined
      ? { reply_parameters: { message_id: replyToMessageId } }
      : {}),
    ...(parseMode ? { parse_mode: parseMode } : {}),
  }).pipe(Effect.flatMap(decodeTelegramSentMessageId))

const sendText = (
  runtime: PieceOfPiRuntime,
  chatId: number,
  text: string,
  replyToMessageId?: number,
  parseMode?: "HTML",
): Effect.Effect<void, TelegramTransportError | TelegramContractError> => {
  const chunks = Array.from(
    { length: Math.max(1, Math.ceil(text.length / TELEGRAM_MESSAGE_LIMIT)) },
    (_, index) =>
      text.slice(
        index * TELEGRAM_MESSAGE_LIMIT,
        (index + 1) * TELEGRAM_MESSAGE_LIMIT,
      ),
  )
  return Effect.forEach(
    chunks,
    (chunk) =>
      sendTelegramMessage(runtime, chatId, chunk, replyToMessageId, parseMode),
    { discard: true },
  )
}

const getUpdates = (
  runtime: PieceOfPiRuntime,
): Effect.Effect<
  ReadonlyArray<TelegramUpdate>,
  TelegramTransportError | TelegramContractError
> =>
  Ref.get(runtime.state).pipe(
    Effect.flatMap((state) =>
      telegramCall(runtime.configuration, "getUpdates", {
        ...(state.nextUpdateId !== undefined
          ? { offset: state.nextUpdateId }
          : {}),
        timeout: TELEGRAM_LONG_POLL_SECONDS,
        allowed_updates: ["message"],
      }),
    ),
    Effect.flatMap(decodeTelegramUpdates),
  )

const agentLabel = (agent: BridgeAgent): string =>
  `${agent.label} (${agent.id.slice(0, 8)})`

const availableAgents = (runtime: PieceOfPiRuntime) =>
  runtime.bridge.listAgents(Date.now())

const questionRelayText = (
  question: BridgeQuestion,
  agent: BridgeAgent,
): string => {
  const title = question.header
    ? `❓ ${question.header}`
    : "❓ Pi needs your answer"
  const choices = question.options?.map(
    (option, index) =>
      `${index + 1}. ${option.label}${option.description ? ` — ${option.description}` : ""}`,
  )
  const body = [
    title,
    `Agent: ${agentLabel(agent)}`,
    `Question q${question.questionId}`,
    "",
    question.question,
    ...(choices ? ["", ...choices] : []),
    ...(question.guess ? ["", `Suggested: ${question.guess}`] : []),
  ]
    .join("\n")
    .slice(0, TELEGRAM_MESSAGE_LIMIT - 120)

  return `${body}\n\nReply directly to this message to answer only q${question.questionId}.`
}

const relayPendingQuestions = (
  runtime: PieceOfPiRuntime,
): Effect.Effect<
  void,
  TelegramTransportError | TelegramContractError | RemoteBridgeError
> =>
  Ref.get(runtime.state).pipe(
    Effect.flatMap((state) => {
      const ownerChatId = state.ownerChatId
      if (ownerChatId === undefined) return Effect.void

      const now = Date.now()
      return Effect.all({
        agents: availableAgents(runtime),
        questions: runtime.bridge.listUnrelayedQuestions(now),
      }).pipe(
        Effect.flatMap(({ agents, questions }) =>
          Effect.forEach(
            questions,
            (question) => {
              const agent = agents.find(({ id }) => id === question.agentId)
              if (!agent) return Effect.void

              return sendTelegramMessage(
                runtime,
                ownerChatId,
                questionRelayText(question, agent),
              ).pipe(
                Effect.flatMap((messageId) =>
                  runtime.bridge.linkTelegramQuestion({
                    agentId: question.agentId,
                    questionId: question.questionId,
                    chatId: ownerChatId,
                    messageId,
                    now: Date.now(),
                  }),
                ),
                Effect.tap(() => Effect.sync(() => emit("question_relayed"))),
                Effect.asVoid,
              )
            },
            { discard: true, concurrency: 1 },
          ),
        ),
      )
    }),
  )

const chooseAgent = (
  runtime: PieceOfPiRuntime,
  state: PieceOfPiState,
): Effect.Effect<BridgeAgent, TelegramTransportError | RemoteBridgeError> =>
  availableAgents(runtime).pipe(
    Effect.flatMap((agents) => {
      const agent = preferredAgent(agents, state.selectedAgentId)
      return agent
        ? Effect.succeed(agent)
        : Effect.fail(
            new TelegramTransportError({
              method: "chooseAgent",
              message:
                "Choose a bridge-ready agent with /agents and /use <label>",
            }),
          )
    }),
  )

const awaitBridgeResult = (
  runtime: PieceOfPiRuntime,
  chatId: number,
  bridgeMessageId: string,
): Effect.Effect<
  void,
  TelegramTransportError | TelegramContractError | RemoteBridgeError
> =>
  runtime.bridge.get(bridgeMessageId, Date.now()).pipe(
    Effect.flatMap((message) => {
      if (message.status === "completed") {
        return sendText(runtime, chatId, message.response).pipe(
          Effect.tap(() => Effect.sync(() => emit("bridge_completed"))),
        )
      }
      if (message.status === "failed") {
        return sendText(
          runtime,
          chatId,
          `Pi bridge failed: ${message.failure}`,
        ).pipe(
          Effect.tap(() =>
            Effect.sync(() =>
              emit("bridge_failed", { failure: message.failure }),
            ),
          ),
        )
      }
      return Effect.sleep(BRIDGE_RESULT_POLL_INTERVAL).pipe(
        Effect.flatMap(() =>
          awaitBridgeResult(runtime, chatId, bridgeMessageId),
        ),
      )
    }),
  )

const enqueueOwnerMessage = (
  runtime: PieceOfPiRuntime,
  update: TelegramUpdate,
): Effect.Effect<
  void,
  TelegramTransportError | TelegramContractError | RemoteBridgeError
> =>
  Ref.get(runtime.state).pipe(
    Effect.flatMap((state) => chooseAgent(runtime, state)),
    Effect.flatMap((agent) =>
      runtime.bridge
        .enqueue({
          targetAgentId: agent.id,
          requesterId: `telegram-owner-${update.message.userId}`,
          dedupeKey: `telegram-update-${update.updateId}`,
          text: update.message.text,
          now: Date.now(),
          ttlMs: BRIDGE_MESSAGE_TTL_MS,
        })
        .pipe(Effect.map((bridgeMessage) => ({ agent, bridgeMessage }))),
    ),
    Effect.tap(({ agent }) =>
      sendText(
        runtime,
        update.message.chatId,
        `Queued for ${agentLabel(agent)}.`,
      ),
    ),
    Effect.flatMap(({ bridgeMessage }) =>
      Effect.forkDaemon(
        awaitBridgeResult(runtime, update.message.chatId, bridgeMessage.id),
      ).pipe(Effect.asVoid),
    ),
  )

const selectAgent = (
  runtime: PieceOfPiRuntime,
  requestedPrefix: string,
): Effect.Effect<
  BridgeAgent,
  TelegramTransportError | PieceOfPiStateError | RemoteBridgeError
> =>
  availableAgents(runtime).pipe(
    Effect.flatMap((agents) => {
      const matches = agents.filter((agent) =>
        agentMatchesSelector(agent, requestedPrefix),
      )
      return matches.length === 1 && matches[0]
        ? Effect.succeed(matches[0])
        : Effect.fail(
            new TelegramTransportError({
              method: "selectAgent",
              message:
                matches.length === 0
                  ? "No agent matches that label or ID prefix"
                  : "Agent selector is ambiguous",
            }),
          )
    }),
    Effect.flatMap((agent) =>
      Ref.updateAndGet(runtime.state, (state) => ({
        ...state,
        selectedAgentId: agent.id,
      })).pipe(
        Effect.flatMap((state) =>
          persistState(runtime.configuration.statePath, state),
        ),
        Effect.as(agent),
      ),
    ),
  )

const handleQuestionReply = (
  runtime: PieceOfPiRuntime,
  update: TelegramUpdate,
): Effect.Effect<
  boolean,
  TelegramTransportError | TelegramContractError | RemoteBridgeError
> => {
  const replyToMessageId = update.message.replyToMessageId
  if (replyToMessageId === undefined) return Effect.succeed(false)

  return runtime.bridge
    .answerTelegramQuestion({
      chatId: update.message.chatId,
      messageId: replyToMessageId,
      answer: update.message.text,
      now: Date.now(),
    })
    .pipe(
      Effect.flatMap((resolution) =>
        sendText(
          runtime,
          update.message.chatId,
          `Answered q${resolution.questionId} for Pi agent ${resolution.agentId.slice(0, 8)}.`,
          update.message.messageId,
        ),
      ),
      Effect.tap(() => Effect.sync(() => emit("question_answered"))),
      Effect.as(true),
      Effect.catchTag("RemoteBridgeError", (error) => {
        if (error.code !== "not_found" && error.code !== "invalid_transition") {
          return Effect.fail(error)
        }

        return sendText(
          runtime,
          update.message.chatId,
          "That reply is not attached to a pending Pi question.",
          update.message.messageId,
        ).pipe(Effect.as(true))
      }),
    )
}

const handleOwnerCommand = (
  runtime: PieceOfPiRuntime,
  update: TelegramUpdate,
): Effect.Effect<
  boolean,
  | TelegramTransportError
  | TelegramContractError
  | PieceOfPiStateError
  | RemoteBridgeError
> => {
  const command = update.message.text.trim()
  if (command === "/start" || command === "/help") {
    return sendText(
      runtime,
      update.message.chatId,
      "Owner authenticated. Commands: /agents, /use <label>, /bridge. Other text defaults to the .config Pi agent.",
      update.message.messageId,
    ).pipe(Effect.as(true))
  }
  if (command === "/agents") {
    return availableAgents(runtime).pipe(
      Effect.flatMap((agents) =>
        sendText(
          runtime,
          update.message.chatId,
          agentListHtml(agents),
          update.message.messageId,
          "HTML",
        ),
      ),
      Effect.as(true),
    )
  }
  if (command === "/bridge") {
    return runtime.bridge.isEnabled().pipe(
      Effect.flatMap((enabled) =>
        sendText(
          runtime,
          update.message.chatId,
          `Pi bridge is ${enabled ? "enabled" : "disabled"}.`,
        ),
      ),
      Effect.as(true),
    )
  }
  if (command.startsWith("/use ")) {
    return selectAgent(runtime, command.slice(5).trim()).pipe(
      Effect.flatMap((agent) =>
        sendText(
          runtime,
          update.message.chatId,
          `Selected ${agentLabel(agent)}.`,
        ),
      ),
      Effect.as(true),
    )
  }
  return Effect.succeed(false)
}

const handleUpdate = (
  runtime: PieceOfPiRuntime,
  update: TelegramUpdate,
): Effect.Effect<
  void,
  | TelegramTransportError
  | TelegramContractError
  | PieceOfPiStateError
  | RemoteBridgeError
> =>
  Ref.get(runtime.state).pipe(
    Effect.flatMap((state) => {
      const authorization = authorizeTelegramMessage(
        state,
        update.message,
        runtime.configuration.ownerUsername,
      )
      if (authorization.kind === "rejected") {
        const rejection = freshClankerRejection(state.rejectionCounter)
        const rejectedState = {
          ...state,
          rejectionCounter: rejection.nextCounter,
        }
        return Ref.set(runtime.state, rejectedState).pipe(
          Effect.flatMap(() =>
            persistState(runtime.configuration.statePath, rejectedState),
          ),
          Effect.flatMap(() =>
            sendText(
              runtime,
              update.message.chatId,
              rejection.text,
              update.message.messageId,
            ),
          ),
          Effect.tap(() => Effect.sync(() => emit("sender_rejected"))),
        )
      }

      const ownerState: PieceOfPiState = {
        ...state,
        ...authorization.state,
        ownerChatId: update.message.chatId,
      }
      return Ref.set(runtime.state, ownerState).pipe(
        Effect.flatMap(() =>
          persistState(runtime.configuration.statePath, ownerState),
        ),
        Effect.flatMap(() => handleQuestionReply(runtime, update)),
        Effect.flatMap((questionHandled) =>
          questionHandled
            ? Effect.succeed(true)
            : handleOwnerCommand(runtime, update),
        ),
        Effect.flatMap((handled) =>
          handled ? Effect.void : enqueueOwnerMessage(runtime, update),
        ),
      )
    }),
    Effect.flatMap(() =>
      Ref.updateAndGet(runtime.state, (state) => ({
        ...state,
        nextUpdateId: update.updateId + 1,
      })),
    ),
    Effect.flatMap((state) =>
      persistState(runtime.configuration.statePath, state),
    ),
  )

const poll = (runtime: PieceOfPiRuntime): Effect.Effect<never, never> =>
  relayPendingQuestions(runtime).pipe(
    Effect.flatMap(() => getUpdates(runtime)),
    Effect.flatMap((updates) =>
      Effect.forEach(updates, (update) => handleUpdate(runtime, update), {
        discard: true,
      }),
    ),
    Effect.catchAll((error) =>
      Effect.sync(() => emit("poll_failed", { error: error._tag })).pipe(
        Effect.flatMap(() => Effect.sleep(POLL_RETRY_INTERVAL)),
      ),
    ),
    Effect.flatMap(() => poll(runtime)),
  )

const program = Effect.gen(function* () {
  const configuration = yield* loadConfiguration
  const initialState = yield* loadState(configuration.statePath)
  const state = yield* Ref.make(initialState)
  const runtime: PieceOfPiRuntime = {
    configuration,
    state,
    bridge: makeRemoteBridgeStore(
      remoteBridgeDatabasePath(process.env.XDG_STATE_HOME, homedir()),
    ),
  }
  emit("service_ready")
  return yield* poll(runtime)
})

Effect.runPromise(Effect.either(program)).then((outcome) => {
  if (Either.isLeft(outcome)) {
    const reason =
      outcome.left instanceof PieceOfPiConfigurationError
        ? outcome.left.code
        : outcome.left._tag
    process.stderr.write(
      `${JSON.stringify({ level: "error", event: "service_failed", reason })}\n`,
    )
    process.exitCode = 1
  }
})
