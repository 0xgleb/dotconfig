import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent"
import { Text } from "@earendil-works/pi-tui"
import { Effect, Either } from "effect"
import {
  type ManagerChatView,
  type ManagerChatOptions,
} from "./manager-chat.ts"
import { buildBoundedTranscript } from "../btw/core.ts"
import {
  registerNativeManager,
  type NativeManager,
  type NativeManagerRuntime,
} from "./manager-native.ts"
import { ManagerSessionError } from "./manager-session-core.ts"
import { requestTodoControl, todoControlAvailable } from "../todo/control.ts"
import { readPromptFile } from "../shared/prompt-text.ts"
import { registerRuntimeVersion } from "../shared/runtime-version.ts"
import type { OwnerAllowance, OwnerWindow } from "./owner-allowance.ts"
import {
  MANAGER_CHAT_ENTRY,
  MANAGER_PRIORITY_ENTRY,
  MANAGER_SUMMARY_ENTRY,
  ManagerError,
  decodeManagerSummary,
  managerObservation,
  managerSummaryExists,
  parseManagerPriorities,
  readManagerPriorities,
  readManagerTasks,
  readManagerTurns,
  type ManagerSummary,
  type ManagerTurn,
} from "./manager-core.ts"

interface ManagerRequest {
  readonly kind: "chat" | "summary"
  readonly body: string
  readonly signal: AbortSignal
}

export type ManagerModel = (
  ctx: ExtensionContext,
  request: ManagerRequest,
) => Promise<Either.Either<string, ManagerError>>

const unsafeControl = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u

const failure = (code: ManagerError["code"], message: string) =>
  Either.left(new ManagerError({ code, message }))

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const answerText = (value: unknown): Either.Either<string, ManagerError> => {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > 12000 ||
    unsafeControl.test(value)
  ) {
    return failure(
      "model_output",
      "Manager response is empty, oversized, or contains terminal controls.",
    )
  }

  return Either.right(value)
}

const decodeReply = (
  response: unknown,
): Either.Either<string, ManagerError> => {
  if (
    !record(response) ||
    (response.stopReason !== "stop" && response.stopReason !== "length") ||
    !Array.isArray(response.content)
  ) {
    return failure("model_output", "Manager returned an incomplete response.")
  }

  const text: string[] = []

  for (const part of response.content) {
    if (!record(part) || (part.type !== "text" && part.type !== "thinking")) {
      return failure("model_output", "Manager returned a non-text response.")
    }

    if (part.type === "text") {
      if (typeof part.text !== "string") {
        return failure("model_output", "Manager returned malformed text.")
      }

      text.push(part.text)
    }
  }

  const joined = text.join("\n")
  return answerText(
    response.stopReason === "length"
      ? `${joined}\n\n[Response reached its output limit.]`
      : joined,
  )
}

export const completeManagerModel: ManagerModel = async (ctx, request) => {
  const model = ctx.model

  if (!model || typeof ctx.modelRegistry.complete !== "function") {
    return failure(
      "model_failed",
      "Manager requires a selected model and the Pi model runtime.",
    )
  }

  if (model.provider === "anthropic") {
    return failure("model_failed", "Manager cannot use Anthropic API billing.")
  }

  const run = async (
    signal: AbortSignal,
  ): Promise<Either.Either<string, ManagerError>> => {
    const result = await Effect.runPromise(
      Effect.either(
        Effect.tryPromise({
          try: async (): Promise<unknown> =>
            ctx.modelRegistry.complete(
              model,
              {
                systemPrompt: readPromptFile(
                  request.kind === "chat"
                    ? "manager-system.md"
                    : "manager-round-summary.md",
                ),
                messages: [
                  {
                    role: "user",
                    content: [{ type: "text", text: request.body }],
                    timestamp: Date.now(),
                  },
                ],
                tools: [],
              },
              { signal, maxTokens: 2048 },
            ),
          catch: () =>
            new ManagerError({
              code: "model_failed",
              message: "Manager model request failed.",
            }),
        }),
      ),
    )

    if (signal.aborted) {
      return failure("cancelled", "Manager request cancelled.")
    }

    return Either.isLeft(result)
      ? Either.left(result.left)
      : decodeReply(result.right)
  }

  return run(request.signal)
}

interface ObservedRound {
  readonly window: OwnerWindow
  readonly observedAt: number
  readonly completed: ReadonlySet<number>
  tools: number
  failures: number
}

export const registerWorkManager = (
  pi: ExtensionAPI,
  guard: OwnerAllowance,
  model: ManagerModel = completeManagerModel,
  view?: ManagerChatView,
  nativeRuntime?: NativeManagerRuntime,
) => {
  let native: NativeManager | undefined
  let context: ExtensionContext | undefined
  let round: ObservedRound | undefined
  let generation = 0
  let chatScope: AbortController | undefined
  const controllers = new Set<AbortController>()

  const token = (ctx: ExtensionContext) => ({
    session: ctx.sessionManager.getSessionId(),
    leaf: ctx.sessionManager.getBranch().at(-1)?.id,
    generation,
  })

  const sameBranch = (
    ctx: ExtensionContext,
    origin: ReturnType<typeof token>,
  ) =>
    origin.generation === generation &&
    ctx.sessionManager.getSessionId() === origin.session &&
    (!origin.leaf ||
      ctx.sessionManager.getBranch().some(entry => entry.id === origin.leaf))

  let pending:
    | {
        readonly window: OwnerWindow
        readonly origin: ReturnType<typeof token>
        readonly observation: unknown
      }
    | undefined

  const showError = (ctx: ExtensionContext, error: ManagerError) =>
    ctx.ui.notify(
      error.message,
      error.code === "cancelled" ? "info" : "warning",
    )

  const save = (
    kind: string,
    data: unknown,
  ): Either.Either<void, ManagerError> =>
    Effect.runSync(
      Effect.either(
        Effect.try({
          try: () => pi.appendEntry(kind, data),
          catch: () =>
            new ManagerError({
              code: "invalid_state",
              message: "Manager session state could not be saved.",
            }),
        }),
      ),
    )

  const observe = (ctx: ExtensionContext) => {
    if (ctx.mode !== "tui" || native?.isManager()) return
    context = ctx
    const allowed = guard.admit()
    if (
      Either.isLeft(allowed) ||
      round?.window.lastOwnerAt === allowed.right.lastOwnerAt
    )
      return
    const tasks = readManagerTasks(ctx.sessionManager.getBranch())
    if (Either.isLeft(tasks)) {
      showError(ctx, tasks.left)
      return
    }
    round = {
      window: allowed.right,
      observedAt: Date.now(),
      completed: new Set(
        tasks.right
          .filter(task => task.status === "completed")
          .map(task => task.id),
      ),
      tools: 0,
      failures: 0,
    }
  }

  const snapshot = (ctx: ExtensionContext) =>
    Either.all([
      readManagerTasks(ctx.sessionManager.getBranch()),
      readManagerPriorities(ctx.sessionManager.getBranch()),
    ]).pipe(
      Either.map(([tasks, priorities]) => {
        const observation = managerObservation(tasks, priorities)
        return {
          tasks,
          priorities,
          workerSession: {
            source: "current_worker_branch" as const,
            maxCharacters: 24_000,
            transcript: buildBoundedTranscript(ctx.sessionManager.getBranch()),
          },
          view: {
            tasks: observation.tasks,
            total: observation.total,
            omitted: observation.omitted,
            completedCount: observation.completedIds.length,
          },
        }
      }),
    )

  const request = async (
    ctx: ExtensionContext,
    kind: ManagerRequest["kind"],
    body: string,
    ownerSignal?: AbortSignal,
  ): Promise<Either.Either<string, ManagerError>> => {
    const controller = new AbortController()
    const signal = ownerSignal
      ? AbortSignal.any([controller.signal, ownerSignal])
      : controller.signal
    controllers.add(controller)
    const result = await Effect.runPromise(
      Effect.either(
        Effect.tryPromise({
          try: () => model(ctx, { kind, body, signal }),
          catch: () =>
            new ManagerError({
              code: "model_failed",
              message: "Manager model boundary failed.",
            }),
        }),
      ),
    )
    controllers.delete(controller)
    if (signal.aborted)
      return failure("cancelled", "Manager request cancelled.")
    if (Either.isLeft(result)) return Either.left(result.left)
    return Either.flatMap(result.right, answerText)
  }

  const flushSummary = async () => {
    const ctx = context
    const stopped = pending
    if (!ctx || !stopped || !ctx.isIdle()) return
    pending = undefined
    if (!sameBranch(ctx, stopped.origin)) return
    const started = performance.now()
    const result = await request(
      ctx,
      "summary",
      JSON.stringify(stopped.observation),
    )
    if (!sameBranch(ctx, stopped.origin)) return
    const elapsedMs = Math.round(performance.now() - started)
    if (!Number.isSafeInteger(elapsedMs) || elapsedMs < 0) {
      showError(
        ctx,
        new ManagerError({
          code: "invalid_state",
          message: "Manager summary duration is invalid.",
        }),
      )
      return
    }
    const summary: ManagerSummary = Either.isLeft(result)
      ? {
          version: 1,
          round: stopped.window.lastOwnerAt,
          status: "failed",
          text: result.left.message,
          elapsedMs,
        }
      : {
          version: 1,
          round: stopped.window.lastOwnerAt,
          status: "completed",
          text: result.right,
          elapsedMs,
        }
    const saved = save(MANAGER_SUMMARY_ENTRY, summary)
    if (Either.isLeft(saved)) {
      showError(ctx, saved.left)
      return
    }
    ctx.ui.setWidget("manager", [
      `Manager · report ${summary.status} · /manager summary`,
    ])
    if (Either.isLeft(result)) showError(ctx, result.left)
  }

  const expire = (window: OwnerWindow) => {
    if (native?.isManager()) return
    const ctx = context
    if (!ctx || ctx.mode !== "tui" || window.status !== "expired") return
    const admitted = guard.admit()
    if (Either.isRight(admitted) || admitted.left.code !== "expired") return

    if (
      !round ||
      round.window.lastOwnerAt !== window.lastOwnerAt ||
      round.window.deadlineAt !== window.deadlineAt
    ) {
      showError(
        ctx,
        new ManagerError({
          code: "invalid_state",
          message: "Summary request does not match the observed worker round.",
        }),
      )
      return
    }

    const exists = managerSummaryExists(
      ctx.sessionManager.getBranch(),
      window.lastOwnerAt,
    )
    if (Either.isLeft(exists)) {
      showError(ctx, exists.left)
      return
    }
    if (exists.right) return
    const current = snapshot(ctx)
    if (Either.isLeft(current)) {
      showError(ctx, current.left)
      return
    }
    const reservation = save(MANAGER_SUMMARY_ENTRY, {
      version: 1,
      round: window.lastOwnerAt,
      status: "started",
    } satisfies ManagerSummary)
    if (Either.isLeft(reservation)) {
      showError(ctx, reservation.left)
      return
    }
    const baseline =
      round?.window.lastOwnerAt === window.lastOwnerAt ? round : undefined
    const completed = baseline
      ? current.right.tasks.filter(
          task =>
            task.status === "completed" && !baseline.completed.has(task.id),
        )
      : undefined
    pending = {
      window,
      origin: token(ctx),
      observation: {
        ownerInputAt: window.lastOwnerAt,
        expiredAt: window.deadlineAt,
        observedAt: baseline?.observedAt,
        snapshotAt: Date.now(),
        settledAtSnapshot: ctx.isIdle(),
        completionDelta: completed
          ? {
              status: "observed",
              tasks: completed.slice(0, 24).map(task => ({
                id: task.id,
                title: Array.from(task.text).slice(0, 240).join(""),
              })),
              omitted: Math.max(0, completed.length - 24),
            }
          : {
              status: "unavailable",
              reason: "A starting task snapshot was not captured.",
            },
        worker: current.right.view,
        workerSession: current.right.workerSession,
        observedToolResults: baseline
          ? { total: baseline.tools, failed: baseline.failures }
          : undefined,
      },
    }
    ctx.ui.setWidget("manager", [
      "Manager · worker allowance expired · preparing report",
    ])
    void flushSummary()
  }

  const resetContext = (ctx: ExtensionContext) => {
    generation += 1
    chatScope?.abort()
    chatScope = undefined
    for (const controller of controllers) controller.abort()
    pending = undefined
    round = undefined
    context = undefined
    observe(ctx)
    if (ctx.mode === "tui") ctx.ui.setWidget("manager", undefined)
  }

  registerRuntimeVersion(pi, "manager", "0.4.2")

  pi.on("session_start", (_event, ctx) => resetContext(ctx))
  pi.on("session_tree", (_event, ctx) => resetContext(ctx))

  pi.on("before_agent_start", (_event, ctx) => {
    observe(ctx)
  })

  pi.on("before_provider_request", (_event, ctx) => {
    observe(ctx)
  })

  pi.on("tool_execution_end", (event, ctx) => {
    observe(ctx)
    if (round && Either.isRight(guard.admit())) {
      round.tools += 1
      if (event.isError) round.failures += 1
    }
  })

  pi.on("agent_settled", (_event, ctx) => {
    observe(ctx)
    void flushSummary()
  })

  pi.on("session_shutdown", () => {
    generation += 1
    chatScope?.abort()
    chatScope = undefined
    for (const controller of controllers) controller.abort()
    pending = undefined
  })

  pi.registerEntryRenderer<ManagerSummary>(
    MANAGER_SUMMARY_ENTRY,
    (entry, _options, theme) => {
      const decoded = decodeManagerSummary(entry.data)
      if (Either.isLeft(decoded)) return new Text(decoded.left.message, 0, 0)
      const summary = decoded.right
      if (summary.status === "started") return undefined
      return new Text(
        `${theme.fg("accent", "Manager round report")} · ${summary.elapsedMs}ms\n${summary.text}`,
        0,
        0,
      )
    },
  )

  const priorities = (
    ctx: ExtensionContext,
    text: string,
  ): Either.Either<string, ManagerError> => {
    const tasks =
      text.trim() === "clear"
        ? Either.right([])
        : readManagerTasks(ctx.sessionManager.getBranch())
    if (Either.isLeft(tasks)) return Either.left(tasks.left)

    const parsed = parseManagerPriorities(text, tasks.right)
    if (Either.isLeft(parsed)) return Either.left(parsed.left)

    return Either.map(save(MANAGER_PRIORITY_ENTRY, parsed.right), () =>
      parsed.right.ids.length
        ? `Continuation order: ${parsed.right.ids.map(id => `#${id}`).join(", ")}`
        : "Manager priority order cleared.",
    )
  }

  if (!view) {
    native = registerNativeManager(
      pi,
      {
        todo: (ctx, request) => {
          const result = requestTodoControl(pi, ctx, request)
          if (Either.isLeft(result))
            return Either.left(
              new ManagerSessionError({
                code:
                  result.left.code === "unconfirmed"
                    ? "unconfirmed"
                    : "unavailable",
                message: result.left.message,
              }),
            )
          return result.right.isError
            ? Either.left(
                new ManagerSessionError({
                  code: "invalid_input",
                  message: result.right.message,
                }),
              )
            : Either.right(result.right.message)
        },
        priorityId: ctx =>
          ctx.sessionManager
            .getBranch()
            .findLast(
              entry =>
                entry.type === "custom" &&
                entry.customType === MANAGER_PRIORITY_ENTRY,
            )?.id ?? "initial",
        priorities: (ctx, text) =>
          Either.mapLeft(
            priorities(ctx, text),
            error =>
              new ManagerSessionError({
                code: "invalid_input",
                message: error.message,
              }),
          ),
        snapshot: ctx =>
          Either.gen(function* () {
            const current = yield* Either.mapLeft(
              snapshot(ctx),
              error =>
                new ManagerSessionError({
                  code: "unsafe_state",
                  message: error.message,
                }),
            )
            const latest = ctx.sessionManager
              .getBranch()
              .findLast(
                entry =>
                  entry.type === "custom" &&
                  entry.customType === MANAGER_SUMMARY_ENTRY,
              )
            let report: ManagerSummary | null = null
            if (latest?.type === "custom") {
              report = yield* Either.mapLeft(
                decodeManagerSummary(latest.data),
                error =>
                  new ManagerSessionError({
                    code: "unsafe_state",
                    message: error.message,
                  }),
              )
            }
            return {
              todoControl: todoControlAvailable(pi),
              view: current.view,
              workerSession: current.workerSession,
              priorities: current.priorities?.ids ?? [],
              roundReport: report,
            }
          }),
      },
      nativeRuntime,
    )
  }

  pi.registerCommand("manager", {
    description:
      "Open native manager chat; priorities <ids> commits continuation order",
    handler: async (args, ctx) => {
      if (ctx.mode !== "tui") {
        ctx.ui.notify("Manager chat requires the interactive TUI.", "warning")
        return
      }

      context = ctx
      const command = args.trim()

      if (native?.isManager()) {
        native.command(ctx, command)
        return
      }
      if (!view && !command.startsWith("priorities ")) {
        if (command && command !== "history" && command !== "summary") {
          ctx.ui.notify(
            "Run /manager, then send your message in the manager session.",
            "info",
          )
          return
        }
        await native?.open(ctx)
        return
      }

      if (command === "reset") {
        chatScope?.abort()
        const saved = save(MANAGER_CHAT_ENTRY, { version: 1, turns: [] })
        if (Either.isLeft(saved)) showError(ctx, saved.left)
        else ctx.ui.notify("Manager conversation cleared.", "info")
        return
      }

      if (command.startsWith("priorities ")) {
        const result = priorities(ctx, command.slice("priorities ".length))
        if (Either.isLeft(result)) showError(ctx, result.left)
        else ctx.ui.notify(result.right, "info")
        return
      }

      if (!view) return

      if (chatScope) {
        showError(
          ctx,
          new ManagerError({
            code: "busy",
            message: "Manager chat is already open.",
          }),
        )
        return
      }

      const history = readManagerTurns(ctx.sessionManager.getBranch())
      if (Either.isLeft(history)) {
        showError(ctx, history.left)
        return
      }

      let notice: string | undefined
      if (command === "summary") {
        const entry = ctx.sessionManager
          .getBranch()
          .findLast(
            item =>
              item.type === "custom" &&
              item.customType === MANAGER_SUMMARY_ENTRY,
          )
        if (entry?.type === "custom") {
          const summary = decodeManagerSummary(entry.data)
          if (Either.isLeft(summary)) {
            showError(ctx, summary.left)
            return
          }
          notice =
            summary.right.status === "started"
              ? "Manager report is preparing."
              : summary.right.text
        } else notice = "No manager round report has been recorded."
      }

      const submit: ManagerChatOptions["submit"] = async (question, signal) => {
        if (question.startsWith("/manager priorities ")) {
          return priorities(ctx, question.slice("/manager priorities ".length))
        }
        if (
          !question.trim() ||
          question.length > 4000 ||
          unsafeControl.test(question)
        ) {
          return failure(
            "invalid_input",
            "Manager questions must fit 4,000 characters and contain no terminal controls.",
          )
        }

        const previous = readManagerTurns(ctx.sessionManager.getBranch())
        if (Either.isLeft(previous)) return Either.left(previous.left)
        const current = snapshot(ctx)
        if (Either.isLeft(current)) return Either.left(current.left)

        const origin = token(ctx)
        const result = await request(
          ctx,
          "chat",
          JSON.stringify({
            worker: current.right.view,
            workerSession: current.right.workerSession,
            priorities: current.right.priorities?.ids ?? [],
            history: previous.right,
            managerNotice: notice,
            question,
          }),
          signal,
        )

        if (!sameBranch(ctx, origin)) {
          return failure(
            "session_changed",
            "Manager response discarded because the session branch changed.",
          )
        }
        if (Either.isLeft(result)) return Either.left(result.left)

        const turns: ManagerTurn[] = [
          ...previous.right,
          { question, answer: result.right },
        ].slice(-12)
        while (
          turns.length > 1 &&
          turns.reduce(
            (total, turn) => total + turn.question.length + turn.answer.length,
            0,
          ) > 24_000
        ) {
          turns.shift()
        }
        const saved = save(MANAGER_CHAT_ENTRY, { version: 1, turns })
        return Either.isLeft(saved) ? Either.left(saved.left) : result
      }

      const scope = new AbortController()
      chatScope = scope
      const initialQuestion =
        command && command !== "history" && command !== "summary"
          ? command
          : undefined
      const opened = await Effect.runPromise(
        Effect.either(
          Effect.tryPromise({
            try: () =>
              view(ctx, {
                turns: history.right,
                signal: scope.signal,
                submit,
                ...(notice === undefined ? {} : { notice }),
                ...(initialQuestion === undefined ? {} : { initialQuestion }),
              }),
            catch: () =>
              new ManagerError({
                code: "invalid_state",
                message: "Manager chat view failed.",
              }),
          }),
        ),
      )

      scope.abort()
      if (chatScope === scope) chatScope = undefined
      if (Either.isLeft(opened)) showError(ctx, opened.left)
    },
  })

  return { expire }
}
