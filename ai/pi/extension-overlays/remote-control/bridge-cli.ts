#!/usr/bin/env node
import { homedir } from "node:os"
import { Effect, Either } from "effect"
import {
  deliverOwnerRelay,
  deliverStakeholderUpdate,
  MAX_OWNER_REPORT_CHARACTERS,
} from "./owner-telegram.ts"
import { remoteBridgeDatabasePath } from "./paths.ts"
import {
  BRIDGE_AGENT_TTL_MS,
  BRIDGE_MESSAGE_TTL_MS,
  MAX_REMOTE_MESSAGE_CHARACTERS,
  MAX_ROSTER_LABEL_CHARACTERS,
  RemoteBridgeError,
  boundedBridgeTextEffect,
  isBridgeWorkDelivery,
  workDeliveryAcceptsInbox,
  type BridgeWorkDelivery,
  type RemoteMessage,
} from "./protocol.ts"
import { makeRemoteBridgeStore } from "./sqlite-store.ts"

const store = makeRemoteBridgeStore(
  remoteBridgeDatabasePath(process.env.XDG_STATE_HOME, homedir()),
)

const DEFAULT_HEARTBEAT_INTERVAL_MS = 5_000

// The shell loop this replaces died on SIGTERM without a trace, so the agent
// vanished from the roster with nothing to explain it. Naming the signal is
// the whole point of running the heartbeat in-process.
const installHeartbeatTerminationLogging = (agentId: string): void => {
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.on(signal, () => {
      process.stderr.write(
        `${JSON.stringify({ protocolVersion: 1, ok: false, event: "heartbeat_stopped", agentId, signal })}\n`,
      )
      process.exit(0)
    })
  }
}

interface HeartbeatWatchInput {
  readonly id: string
  readonly label: string
  readonly cwd: string
  readonly accepting: boolean
  readonly workDelivery: BridgeWorkDelivery
  readonly intervalMs: number
}

// A refresh failure is usually a transient sqlite lock. Exiting would drop the
// agent off the roster for good, so report it and keep beating.
const heartbeatForever = (
  input: HeartbeatWatchInput,
): Effect.Effect<never, RemoteBridgeError> =>
  Effect.gen(function* () {
    for (;;) {
      yield* Effect.sleep(input.intervalMs)
      const beat = yield* Effect.either(
        store.heartbeatAgent({
          id: input.id,
          label: input.label,
          cwd: input.cwd,
          accepting: input.accepting,
          workDelivery: input.workDelivery,
          now: Date.now(),
          ttlMs: BRIDGE_AGENT_TTL_MS,
        }),
      )
      if (Either.isLeft(beat)) {
        process.stderr.write(
          `${JSON.stringify({ protocolVersion: 1, ok: false, error: { code: beat.left.code, message: beat.left.message.slice(0, 160) } })}\n`,
        )
      }
    }
  })

const option = (args: readonly string[], name: string): string | undefined => {
  const index = args.indexOf(name)
  return index === -1 ? undefined : args[index + 1]
}

const requiredOption = (
  args: readonly string[],
  name: string,
): Effect.Effect<string, RemoteBridgeError> => {
  const value = option(args, name)?.trim()
  return value
    ? Effect.succeed(value)
    : Effect.fail(
        new RemoteBridgeError({
          code: "invalid_input",
          message: `${name} required`,
        }),
      )
}

const readStdin = (
  maximum = MAX_REMOTE_MESSAGE_CHARACTERS,
): Effect.Effect<string, RemoteBridgeError> =>
  Effect.async<string, RemoteBridgeError>(resume => {
    let text = ""
    let settled = false
    const finish = (result: Effect.Effect<string, RemoteBridgeError>): void => {
      if (settled) return
      settled = true
      resume(result)
    }
    process.stdin.setEncoding("utf8")
    process.stdin.on("data", (chunk: string) => {
      text += chunk
      if (text.length <= maximum + 1) return
      process.stdin.destroy()
      finish(
        Effect.fail(
          new RemoteBridgeError({
            code: "invalid_input",
            message: `stdin exceeds ${maximum} characters`,
          }),
        ),
      )
    })
    process.stdin.on("end", () => finish(Effect.succeed(text)))
    process.stdin.on("error", () =>
      finish(
        Effect.fail(
          new RemoteBridgeError({
            code: "io",
            message: "could not read stdin",
          }),
        ),
      ),
    )
  })

const publicMessage = (
  message: RemoteMessage,
): Readonly<Record<string, unknown>> => ({
  id: message.id,
  targetAgentId: message.targetAgentId,
  status: message.status,
  createdAt: message.createdAt,
  expiresAt: message.expiresAt,
  ...(message.status === "completed"
    ? { response: message.response, completedAt: message.completedAt }
    : {}),
  ...(message.status === "failed"
    ? { failure: message.failure, completedAt: message.completedAt }
    : {}),
})

const command = (
  args: readonly string[],
): Effect.Effect<unknown, RemoteBridgeError> => {
  const [action] = args
  if (action === "agents") {
    return Effect.map(store.listAgents(Date.now()), agents =>
      agents.map(
        ({
          id,
          label,
          accepting,
          expiresAt,
          workDelivery,
          queuedMessages,
        }) => ({
          id,
          label,
          accepting,
          expiresAt,
          workDelivery,
          queuedMessages,
          queueState:
            queuedMessages > 0 && !workDeliveryAcceptsInbox(workDelivery)
              ? "queued-undrainable"
              : workDeliveryAcceptsInbox(workDelivery)
                ? "drainable"
                : "no-inbox",
        }),
      ),
    )
  }
  if (action === "send") {
    return Effect.gen(function* () {
      const targetAgentId = yield* requiredOption(args, "--agent")
      const dedupeKey = yield* requiredOption(args, "--dedupe")
      const requesterId =
        option(args, "--requester")?.trim() || "unknown-bridge-sender"
      if (
        requesterId === "owner-pane" ||
        requesterId.startsWith("telegram-owner-")
      ) {
        return yield* Effect.fail(
          new RemoteBridgeError({
            code: "invalid_input",
            message: "--requester uses a reserved owner-ingress identity",
          }),
        )
      }
      const text = yield* readStdin()
      const message = yield* store.enqueue({
        targetAgentId,
        requesterId,
        dedupeKey,
        text,
        now: Date.now(),
        ttlMs: BRIDGE_MESSAGE_TTL_MS,
      })
      return publicMessage(message)
    })
  }
  // Outbound reports are transport, not inbox messages. The old relay frame
  // enqueued a report to a dispatcher and depended on that agent to notice the
  // frame; on a non-dispatch lane it instead re-entered Pi wearing the same
  // envelope as authenticated owner input. This command calls the verified
  // Telegram sender directly and records the actual agent in the message.
  if (action === "owner-report") {
    return Effect.gen(function* () {
      const sender = yield* requiredOption(args, "--sender")
      const boundedSender = yield* boundedBridgeTextEffect(
        "--sender",
        sender,
        MAX_ROSTER_LABEL_CHARACTERS,
      )
      const report = yield* readStdin(MAX_OWNER_REPORT_CHARACTERS).pipe(
        Effect.flatMap(text =>
          boundedBridgeTextEffect("report", text, MAX_OWNER_REPORT_CHARACTERS),
        ),
      )
      yield* deliverOwnerRelay(report, boundedSender).pipe(
        Effect.mapError(
          error =>
            new RemoteBridgeError({
              code: "io",
              message: `owner report was not delivered: ${error.code}`,
            }),
        ),
      )
      return { outcome: "delivered", sender: boundedSender }
    })
  }
  if (action === "stakeholder-update") {
    return Effect.gen(function* () {
      const sender = yield* requiredOption(args, "--sender")
      const boundedSender = yield* boundedBridgeTextEffect(
        "--sender",
        sender,
        MAX_ROSTER_LABEL_CHARACTERS,
      )
      const update = yield* readStdin(MAX_OWNER_REPORT_CHARACTERS).pipe(
        Effect.flatMap(text =>
          boundedBridgeTextEffect(
            "stakeholder update",
            text,
            MAX_OWNER_REPORT_CHARACTERS,
          ),
        ),
      )
      yield* deliverStakeholderUpdate(update).pipe(
        Effect.mapError(
          error =>
            new RemoteBridgeError({
              code: "io",
              message: `stakeholder update was not delivered: ${error.code}`,
            }),
        ),
      )
      return {
        outcome: "delivered",
        sender: boundedSender,
        mode: "stakeholder_update",
      }
    })
  }
  // `ask_user` is a Pi tool, so until now only a native Pi session could put a
  // question in front of the owner. Every other lane - Claude Code, cursor -
  // had to guess or relay a report and hope, which is the opposite of what the
  // question cards are for. These two verbs are the missing entry point: `ask`
  // publishes into the same store the relay already drains, and `answer` is
  // how a lane with no push inbox collects the reply.
  if (action === "ask") {
    return Effect.gen(function* () {
      const agentId = yield* requiredOption(args, "--agent")
      const header = option(args, "--header")?.trim()
      const question = yield* readStdin()
      const options = (option(args, "--options") ?? "")
        .split("|")
        .map(label => label.trim())
        .filter(label => label.length > 0)
        .map(label => ({ label }))
      // Telegram binds its card to (agent_id, question_id), so the id has to
      // be unique per agent and stable once relayed. Seconds since epoch is
      // both, and stays inside the integer the card round-trips.
      const questionId = Math.floor(Date.now() / 1_000)
      const boundedQuestion = yield* boundedBridgeTextEffect(
        "question",
        question,
        MAX_REMOTE_MESSAGE_CHARACTERS,
      )
      yield* store.syncQuestions({
        agentId,
        questions: [
          {
            id: questionId,
            status: "pending" as const,
            question: boundedQuestion,
            ...(header ? { header } : {}),
            ...(options.length > 0 ? { options } : {}),
          },
        ],
        now: Date.now(),
      })
      return { agentId, questionId, status: "pending" }
    })
  }
  if (action === "answer") {
    return Effect.gen(function* () {
      const agentId = yield* requiredOption(args, "--agent")
      const resolution = yield* store.takeQuestionResolution({
        agentId,
        now: Date.now(),
      })
      return resolution ?? { agentId, status: "pending" }
    })
  }
  // The skill tells agents not to stall on a question, so answers routinely
  // arrive out of band and leave a card the asker cannot retract.
  if (action === "dismiss") {
    return Effect.gen(function* () {
      const agentId = yield* requiredOption(args, "--agent")
      const questionId = yield* requiredOption(args, "--question")
      const parsedQuestionId = Number(questionId)
      if (!Number.isSafeInteger(parsedQuestionId) || parsedQuestionId <= 0) {
        return yield* Effect.fail(
          new RemoteBridgeError({
            code: "invalid_input",
            message: "--question must be a positive integer",
          }),
        )
      }
      const question = yield* store.dismissQuestion({
        agentId,
        questionId: parsedQuestionId,
        now: Date.now(),
      })
      return {
        agentId: question.agentId,
        questionId: question.questionId,
        status: "dismissed",
      }
    })
  }
  // The roster makes every lane addressable, but `claimNext` was only ever
  // called by the Pi turn loop with the Pi session id, so a message aimed at a
  // Claude Code or cursor lane had no consumer in existence and sat queued
  // until it expired an hour later. The store already claims by
  // `target_agent_id`; only this entry point was missing.
  if (action === "inbox") {
    return Effect.gen(function* () {
      const agentId = yield* requiredOption(args, "--agent")
      const message = yield* store.claimNext({ agentId, now: Date.now() })
      if (message === undefined || message.status !== "claimed") {
        return { agentId, status: "empty" }
      }
      return {
        id: message.id,
        status: message.status,
        claimToken: message.claimToken,
        requesterId: message.requesterId,
        dedupeKey: message.dedupeKey,
        text: message.text,
        createdAt: message.createdAt,
        expiresAt: message.expiresAt,
      }
    })
  }
  if (action === "respond") {
    return Effect.gen(function* () {
      const messageId = yield* requiredOption(args, "--id")
      const claimToken = yield* requiredOption(args, "--token")
      const response = yield* readStdin()
      return publicMessage(
        yield* store.complete({
          messageId,
          claimToken,
          response,
          now: Date.now(),
        }),
      )
    })
  }
  if (action === "result") {
    return Effect.gen(function* () {
      const id = yield* requiredOption(args, "--id")
      return publicMessage(yield* store.get(id, Date.now()))
    })
  }
  if (action === "register") {
    return Effect.gen(function* () {
      const id = yield* requiredOption(args, "--agent-id")
      const label = yield* requiredOption(args, "--label")
      const cwd = yield* requiredOption(args, "--cwd")
      // Registration is where a bad roster field is cheap to refuse. The
      // prompt builder neutralizes what reaches it, but a caller that sends a
      // relative cwd or an unbounded label should learn so here rather than
      // silently appear on the roster in a mangled form.
      const boundedLabel = yield* boundedBridgeTextEffect(
        "--label",
        label,
        MAX_ROSTER_LABEL_CHARACTERS,
      )
      if (!cwd.startsWith("/")) {
        return yield* Effect.fail(
          new RemoteBridgeError({
            code: "invalid_input",
            message: "--cwd must be an absolute path",
          }),
        )
      }
      const accepting = option(args, "--accepting")?.trim()
      if (
        accepting !== undefined &&
        accepting !== "true" &&
        accepting !== "false"
      ) {
        return yield* Effect.fail(
          new RemoteBridgeError({
            code: "invalid_input",
            message: "--accepting must be true or false",
          }),
        )
      }
      const requestedWorkDelivery =
        option(args, "--work-delivery")?.trim() ?? "monitor-only"
      if (
        !isBridgeWorkDelivery(requestedWorkDelivery) ||
        requestedWorkDelivery === "native-pi"
      ) {
        return yield* Effect.fail(
          new RemoteBridgeError({
            code: "invalid_input",
            message:
              "--work-delivery must be cli-poll, inline-only, or monitor-only",
          }),
        )
      }
      const workDelivery: BridgeWorkDelivery = requestedWorkDelivery
      const agent = yield* store.heartbeatAgent({
        id,
        label: boundedLabel,
        cwd,
        accepting: accepting !== "false",
        workDelivery,
        now: Date.now(),
        ttlMs: BRIDGE_AGENT_TTL_MS,
      })
      const watching = args.includes("--watch")
      if (watching) {
        const intervalMs = Number(
          option(args, "--interval-ms") ?? DEFAULT_HEARTBEAT_INTERVAL_MS,
        )
        if (
          !Number.isSafeInteger(intervalMs) ||
          intervalMs <= 0 ||
          intervalMs >= BRIDGE_AGENT_TTL_MS
        ) {
          return yield* Effect.fail(
            new RemoteBridgeError({
              code: "invalid_input",
              message: `--interval-ms must be a positive integer below the ${BRIDGE_AGENT_TTL_MS}ms agent TTL`,
            }),
          )
        }
        process.stdout.write(
          `${JSON.stringify({ protocolVersion: 1, ok: true, result: { id: agent.id, watching: true, intervalMs } })}\n`,
        )
        installHeartbeatTerminationLogging(agent.id)
        return yield* heartbeatForever({
          id,
          label: boundedLabel,
          cwd,
          accepting: accepting !== "false",
          workDelivery,
          intervalMs,
        })
      }
      return {
        id: agent.id,
        label: agent.label,
        accepting: agent.accepting,
        workDelivery: agent.workDelivery,
        queuedMessages: agent.queuedMessages,
        expiresAt: agent.expiresAt,
      }
    })
  }
  if (action === "enable") return store.setEnabled(true)
  if (action === "disable") return store.setEnabled(false)
  if (action === "status") return store.isEnabled()
  return Effect.fail(
    new RemoteBridgeError({
      code: "invalid_input",
      message:
        "usage: pi-bridge agents | send --agent ID --dedupe KEY | owner-report --sender ID | stakeholder-update --sender ID | result --id ID | inbox --agent ID | respond --id ID --token TOKEN | register --agent-id ID --label LABEL --cwd PATH [--work-delivery cli-poll|inline-only|monitor-only] [--watch] [--interval-ms N] | ask --agent ID [--header TEXT] [--options 'A|B'] | answer --agent ID | dismiss --agent ID --question ID | enable | disable | status",
    }),
  )
}

const run = Effect.either(command(process.argv.slice(2))).pipe(
  Effect.tap(result =>
    Effect.sync(() => {
      if (Either.isRight(result)) {
        process.stdout.write(
          `${JSON.stringify({ protocolVersion: 1, ok: true, result: result.right })}\n`,
        )
        return
      }
      process.stderr.write(
        `${JSON.stringify({
          protocolVersion: 1,
          ok: false,
          error: {
            code: result.left.code,
            message: result.left.message.slice(0, 160),
          },
        })}\n`,
      )
      process.exitCode = 1
    }),
  ),
)

Effect.runPromise(run)
