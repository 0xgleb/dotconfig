import {
  DynamicBorder,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent"
import { Container, Input, matchesKey, Text } from "@earendil-works/pi-tui"
import { Data, Effect } from "effect"
import { Type } from "typebox"
import {
  applyQuestionAction,
  decodeQuestionState,
  emptyQuestionState,
  pendingQuestions,
  repairMisroutedPromptAnswers,
  repeatedQuestion,
  type QuestionAction,
  type QuestionOption,
  type QuestionState,
} from "./state.ts"
import {
  QUESTION_ASK_EVENT,
  QUESTION_PENDING_COUNT_EVENT,
  QUESTION_REMOTE_RESOLUTION_EVENT,
  QUESTION_RESOLVED_EVENT,
  QUESTION_STATE_ENTRY,
  QUESTION_STATE_EVENT,
  type RemoteUserQuestionResolution,
  type UserQuestionPendingCount,
  type UserQuestionRequest,
  type UserQuestionResolution,
  type UserQuestionSnapshot,
  type UserQuestionStateSnapshot,
} from "../shared/question-events.ts"
import { registerRuntimeVersion } from "../shared/runtime-version.ts"
import { pendingQuestionContext, questionListText } from "./presentation.ts"

const QUESTION_MESSAGE = "pi.questions.list"
const QUESTION_STATUS_KEY = "pi-questions"

interface QuestionRequest {
  readonly action:
    | "list"
    | "ask"
    | "resolve"
    | "withdraw"
    | "replace"
    | "reopen"
    | "clear_resolved"
  readonly question?: string
  readonly header?: string
  readonly guess?: string
  readonly options?: readonly QuestionOption[]
  readonly id?: number
  readonly answer?: string
  readonly reason?: string
}

class QuestionActionError extends Data.TaggedError("QuestionActionError")<{
  readonly message: string
}> {}

const invalidQuestionAction = (
  message: string,
): Effect.Effect<never, QuestionActionError> =>
  Effect.fail(new QuestionActionError({ message }))

const parseAction = (
  request: QuestionRequest,
  state: QuestionState,
): Effect.Effect<QuestionAction, QuestionActionError> =>
  Effect.gen(function* () {
    switch (request.action) {
      case "list":
        return { action: "list" }
      case "clear_resolved":
        return { action: "clear_resolved" }
      case "ask": {
        const question = request.question?.trim()
        if (!question)
          return yield* invalidQuestionAction("question required for ask")
        return {
          action: "ask",
          question,
          ...(request.header?.trim() ? { header: request.header.trim() } : {}),
          ...(request.guess?.trim() ? { guess: request.guess.trim() } : {}),
          ...(request.options && request.options.length > 0
            ? { options: request.options }
            : {}),
        }
      }
      case "resolve": {
        if (request.id === undefined)
          return yield* invalidQuestionAction("id required for resolve")
        const answer = request.answer?.trim()
        if (!answer)
          return yield* invalidQuestionAction("answer required for resolve")
        const target = state.questions.find(({ id }) => id === request.id)
        if (!target)
          return yield* invalidQuestionAction(
            `Question q${request.id} not found`,
          )
        if (target.status !== "pending")
          return yield* invalidQuestionAction(
            `Question q${request.id} is already resolved`,
          )
        return { action: "resolve", id: request.id, answer }
      }
      case "withdraw": {
        if (request.id === undefined)
          return yield* invalidQuestionAction("id required for withdraw")
        const reason = request.reason?.trim()
        if (!reason)
          return yield* invalidQuestionAction("reason required for withdraw")
        const target = state.questions.find(({ id }) => id === request.id)
        if (!target)
          return yield* invalidQuestionAction(
            `Question q${request.id} not found`,
          )
        if (target.status === "resolved" && target.withdrawn)
          return yield* invalidQuestionAction(
            `Question q${request.id} is already withdrawn`,
          )
        return { action: "withdraw", id: request.id, reason }
      }
      case "replace": {
        if (request.id === undefined)
          return yield* invalidQuestionAction("id required for replace")
        const reason = request.reason?.trim()
        if (!reason)
          return yield* invalidQuestionAction("reason required for replace")
        const question = request.question?.trim()
        if (!question)
          return yield* invalidQuestionAction("question required for replace")
        const target = state.questions.find(({ id }) => id === request.id)
        if (!target)
          return yield* invalidQuestionAction(
            `Question q${request.id} not found`,
          )
        if (target.status === "resolved" && target.withdrawn)
          return yield* invalidQuestionAction(
            `Question q${request.id} is already withdrawn`,
          )
        return {
          action: "replace",
          id: request.id,
          reason,
          question,
          ...(request.header?.trim() ? { header: request.header.trim() } : {}),
          ...(request.guess?.trim() ? { guess: request.guess.trim() } : {}),
          ...(request.options && request.options.length > 0
            ? { options: request.options }
            : {}),
        }
      }
      case "reopen": {
        if (request.id === undefined)
          return yield* invalidQuestionAction("id required for reopen")
        const target = state.questions.find(({ id }) => id === request.id)
        if (!target)
          return yield* invalidQuestionAction(
            `Question q${request.id} not found`,
          )
        if (target.status !== "resolved")
          return yield* invalidQuestionAction(
            `Question q${request.id} is already pending`,
          )
        return { action: "reopen", id: request.id }
      }
    }
  })

const questionsExtension: (pi: ExtensionAPI) => void = pi => {
  registerRuntimeVersion(pi, "questions", "2026.09.03.1")
  let state = emptyQuestionState
  let dialogOpen = false
  let latestCtx: ExtensionContext | undefined

  const publishState = (): void => {
    const questions: readonly UserQuestionSnapshot[] = state.questions.map(
      (question): UserQuestionSnapshot => {
        const snapshot = {
          id: question.id,
          question: question.question,
          ...(question.header ? { header: question.header } : {}),
          ...(question.guess ? { guess: question.guess } : {}),
          ...(question.options ? { options: question.options } : {}),
        }
        return question.status === "resolved"
          ? { ...snapshot, status: "resolved", answer: question.answer }
          : { ...snapshot, status: "pending" }
      },
    )
    const snapshot: UserQuestionStateSnapshot = { questions }
    pi.events.emit(QUESTION_STATE_EVENT, snapshot)
  }

  const render = (ctx: ExtensionContext) => {
    const pending = pendingQuestions(state).length
    const pendingCount: UserQuestionPendingCount = { pending }
    pi.events.emit(QUESTION_PENDING_COUNT_EVENT, pendingCount)
    ctx.ui.setStatus(
      QUESTION_STATUS_KEY,
      pending > 0 ? `awaiting:${pending} · /questions` : undefined,
    )
    if (ctx.hasUI) ctx.ui.setWidget(QUESTION_STATUS_KEY, undefined)
  }

  const restore = (ctx: ExtensionContext) => {
    const entry = ctx.sessionManager
      .getBranch()
      .filter(
        candidate =>
          candidate.type === "custom" &&
          candidate.customType === QUESTION_STATE_ENTRY,
      )
      .at(-1)
    const restored =
      entry?.type === "custom"
        ? (decodeQuestionState(entry.data) ?? emptyQuestionState)
        : emptyQuestionState
    state = repairMisroutedPromptAnswers(restored)
    if (
      state.questions.some(
        (question, index) => question !== restored.questions[index],
      )
    ) {
      pi.appendEntry(QUESTION_STATE_ENTRY, state)
    }
    render(ctx)
    publishState()
  }

  const persist = (ctx: ExtensionContext) => {
    pi.appendEntry(QUESTION_STATE_ENTRY, state)
    render(ctx)
    publishState()
  }

  const showQuestions = () => {
    pi.sendMessage({
      customType: QUESTION_MESSAGE,
      content: questionListText(state),
      display: true,
    })
  }

  const resolveQuestion = (
    ctx: ExtensionContext,
    id: number,
    answer: string,
  ): boolean => {
    const target = state.questions.find(question => question.id === id)
    const boundedAnswer = answer.trim().slice(0, 4_000)
    if (!target || target.status !== "pending" || !boundedAnswer) return false

    state = applyQuestionAction(state, {
      action: "resolve",
      id,
      answer: boundedAnswer,
    })
    persist(ctx)
    const resolution: UserQuestionResolution = { id, answer: boundedAnswer }
    pi.events.emit(QUESTION_RESOLVED_EVENT, resolution)
    pi.sendMessage(
      {
        customType: "pi.questions.answered",
        content: `Resolved durable question q${id} with exact typed answer: ${boundedAnswer}\nContinue the waiting work using this answer.`,
        display: false,
      },
      { triggerTurn: true, deliverAs: "followUp" },
    )
    return true
  }

  const showQuestionDialog = async (
    ctx: ExtensionContext,
    questionId?: number,
  ) => {
    if (!ctx.hasUI || dialogOpen) return
    dialogOpen = true
    try {
      const pending = pendingQuestions(state)
      const question =
        questionId === undefined
          ? pending[0]
          : pending.find(({ id }) => id === questionId)
      if (!question) return
      const progress =
        state.questions.findIndex(({ id }) => id === question.id) + 1
      const total = state.questions.length
      const answer = await ctx.ui.custom<string | null>(
        (tui, theme, _keybindings, done) => {
          const input = new Input()
          const container = new Container()
          const accent = (text: string) => theme.fg("accent", text)
          const header = question.header
            ? `ACTION REQUIRED · ${question.header}`
            : "ACTION REQUIRED"
          container.addChild(new DynamicBorder(accent))
          container.addChild(
            new Text(
              `${theme.bold(accent(header))}${theme.fg("muted", `  Decision ${progress} of ${total}`)}`,
              1,
              0,
            ),
          )
          container.addChild(
            new Text(theme.fg("text", question.question), 1, 1),
          )
          if (question.options && question.options.length > 0) {
            container.addChild(
              new Text(
                question.options
                  .map(
                    (option, index) =>
                      `${accent(`${index + 1}.`)} ${theme.fg("text", option.label)}${
                        option.description
                          ? theme.fg("muted", ` — ${option.description}`)
                          : ""
                      }`,
                  )
                  .join("\n"),
                1,
                0,
              ),
            )
          }
          if (question.guess) {
            container.addChild(
              new Text(
                `${theme.fg("muted", "Suggested answer")}\n${accent(question.guess)}`,
                1,
                1,
              ),
            )
          }
          container.addChild(
            new Text(theme.bold(theme.fg("text", "Your answer")), 1, 1),
          )
          container.addChild(input)
          container.addChild(
            new Text(
              theme.fg(
                "dim",
                `${question.options?.length ? `${theme.bold(`1-${question.options.length}`)} choose  ·  ` : ""}${theme.bold("enter")} submit  ·  ${theme.bold("tab")} use suggestion  ·  ${theme.bold("esc")} answer later`,
              ),
              1,
              1,
            ),
          )
          container.addChild(new DynamicBorder(accent))
          input.onSubmit = value => {
            const trimmed = value.trim()
            if (trimmed) done(trimmed)
          }
          input.onEscape = () => done(null)
          return {
            get focused() {
              return input.focused
            },
            set focused(value: boolean) {
              input.focused = value
            },
            render: (width: number) => container.render(width),
            invalidate: () => container.invalidate(),
            handleInput: (data: string) => {
              const optionIndex = /^[1-9]$/.test(data) ? Number(data) - 1 : -1
              const option = question.options?.[optionIndex]
              if (option) done(option.label)
              else if (matchesKey(data, "tab") && question.guess)
                input.setValue(question.guess)
              else input.handleInput(data)
              tui.requestRender()
            },
          }
        },
        {
          overlay: true,
          overlayOptions: {
            width: "70%",
            minWidth: 56,
            maxHeight: "80%",
            anchor: "center",
            margin: 1,
          },
        },
      )
      if (answer !== null) resolveQuestion(ctx, question.id, answer)
    } finally {
      dialogOpen = false
    }
  }

  const selectQuestion = async (ctx: ExtensionContext) => {
    const pending = pendingQuestions(state)
    if (pending.length === 0) {
      showQuestions()
      return
    }
    if (pending.length === 1) {
      await showQuestionDialog(ctx, pending[0]?.id)
      return
    }
    const choices = pending.map(
      question =>
        `q${question.id}  ${question.question.replace(/\s+/g, " ").slice(0, 100)}`,
    )
    const selected = await ctx.ui.select(
      "Pending questions · ↑/↓ select · enter open · esc close",
      choices,
    )
    if (selected === undefined) return
    const selectedIndex = choices.indexOf(selected)
    await showQuestionDialog(ctx, pending[selectedIndex]?.id)
  }

  pi.on("session_start", (_event, ctx) => {
    latestCtx = ctx
    restore(ctx)
  })
  pi.on("session_compact", () => {
    pi.appendEntry(QUESTION_STATE_ENTRY, state)
  })
  pi.on("session_shutdown", (_event, ctx) => {
    latestCtx = undefined
    ctx.ui.setStatus(QUESTION_STATUS_KEY, undefined)
    ctx.ui.setWidget(QUESTION_STATUS_KEY, undefined)
  })
  pi.events.on(QUESTION_ASK_EVENT, (request: UserQuestionRequest) => {
    if (!latestCtx) return
    const question = request.question.trim().slice(0, 4_000)
    if (!question) return
    const repeated = repeatedQuestion(state, question)
    if (repeated) {
      latestCtx.ui.notify(
        repeated.status === "resolved"
          ? `Not queued: q${repeated.id} already resolved this decision.`
          : `Not queued: q${repeated.id} already asks this decision.`,
        "warning",
      )
      return
    }
    state = applyQuestionAction(state, {
      action: "ask",
      question,
      ...(request.header?.trim()
        ? { header: request.header.trim().slice(0, 16) }
        : {}),
      ...(request.guess?.trim()
        ? { guess: request.guess.trim().slice(0, 2_000) }
        : {}),
      ...(request.options &&
      request.options.length >= 2 &&
      request.options.length <= 4
        ? { options: request.options }
        : {}),
    })
    persist(latestCtx)
    latestCtx.ui.notify(
      `Queued question q${state.nextId - 1}. Open /questions to answer.`,
      "info",
    )
  })

  pi.events.on(
    QUESTION_REMOTE_RESOLUTION_EVENT,
    (resolution: RemoteUserQuestionResolution) => {
      if (!latestCtx) return
      resolveQuestion(latestCtx, resolution.id, resolution.answer)
    },
  )

  pi.on("before_agent_start", event => {
    const content = pendingQuestionContext(state)
    return content
      ? { systemPrompt: `${event.systemPrompt}\n\n${content}` }
      : undefined
  })

  pi.registerCommand("questions", {
    description: "Show questions awaiting user input",
    async handler(_args, ctx) {
      restore(ctx)
      await selectQuestion(ctx)
    },
  })

  const executeQuestionAction = (
    request: QuestionRequest,
    ctx: ExtensionContext,
  ) =>
    Effect.gen(function* () {
      const action = yield* parseAction(request, state)
      if (action.action === "ask" || action.action === "replace") {
        const dedupeState =
          action.action === "replace"
            ? {
                ...state,
                questions: state.questions.filter(
                  question => question.id !== action.id,
                ),
              }
            : state
        const repeated = repeatedQuestion(dedupeState, action.question)
        if (repeated) {
          const text =
            repeated.status === "resolved"
              ? `Not queued: q${repeated.id} already resolved this decision. Answer: ${repeated.answer}`
              : `Not queued: q${repeated.id} already asks this decision.`
          return {
            content: [{ type: "text" as const, text }],
            details: {
              outcome: "duplicate",
              action: action.action,
              duplicateQuestionId: repeated.id,
              state,
            },
          }
        }
      }
      const priorState = state
      return yield* Effect.try({
        try: () => {
          state = applyQuestionAction(priorState, action)
          if (action.action !== "list") persist(ctx)
          const text =
            action.action === "ask"
              ? `Queued question q${state.nextId - 1}. The user can answer it explicitly with /questions.`
              : action.action === "resolve"
                ? `Resolved question q${action.id}`
                : action.action === "withdraw"
                  ? `Withdrew question q${action.id}`
                  : action.action === "replace"
                    ? `Replaced question q${action.id} with q${state.nextId - 1}`
                    : action.action === "reopen"
                      ? `Reopened question q${action.id}`
                      : questionListText(state)
          if (action.action === "ask" || action.action === "replace")
            ctx.ui.notify(text, "info")
          return {
            content: [{ type: "text" as const, text }],
            details: {
              outcome: "success",
              action: action.action,
              state,
            },
          }
        },
        catch: cause => {
          state = priorState
          return new QuestionActionError({
            message:
              cause instanceof Error ? cause.message : "Question action failed",
          })
        },
      })
    })

  pi.registerTool({
    name: "ask_user",
    label: "Question queue",
    description:
      "Queue, list, resolve, withdraw, replace, or reopen persistent non-blocking questions for the user.",
    promptSnippet:
      "Queue a persistent question for the user without blocking unrelated work",
    promptGuidelines: [
      "Use ask_user when a user decision is required but independent work remains executable.",
      "Before ask_user action=ask, inspect current user messages, ask_user list, and active todos; when prior work may already answer the decision, inspect memory_search and session_search first.",
      "Never use ask_user to repeat a pending, resolved, or otherwise already-answered decision unless newer human input explicitly reopens it.",
      "Use withdraw for an explicitly withdrawn card, replace to atomically withdraw and correct one, and reopen only when the original card remains accurate.",
      "Include a short header, the current best guess, and 2-4 concise options when the decision has bounded choices.",
      "Continue independent work after asking; resolve the question with a concise answer summary when the user responds.",
      "Queued questions stay passive until the user explicitly opens /questions; never treat ordinary prompt input as an answer.",
    ],
    parameters: Type.Object({
      action: Type.Union([
        Type.Literal("list"),
        Type.Literal("ask"),
        Type.Literal("resolve"),
        Type.Literal("withdraw"),
        Type.Literal("replace"),
        Type.Literal("reopen"),
        Type.Literal("clear_resolved"),
      ]),
      question: Type.Optional(Type.String()),
      header: Type.Optional(Type.String({ maxLength: 16 })),
      guess: Type.Optional(Type.String()),
      options: Type.Optional(
        Type.Array(
          Type.Object({
            label: Type.String({ minLength: 1, maxLength: 80 }),
            description: Type.Optional(Type.String({ maxLength: 160 })),
          }),
          { minItems: 2, maxItems: 4 },
        ),
      ),
      id: Type.Optional(Type.Integer({ minimum: 1 })),
      answer: Type.Optional(Type.String()),
      reason: Type.Optional(Type.String()),
    }),
    async execute(
      _toolCallId,
      request: QuestionRequest,
      _signal,
      _onUpdate,
      ctx,
    ) {
      restore(ctx)
      return Effect.runPromise(
        executeQuestionAction(request, ctx).pipe(
          Effect.match({
            onFailure: error => ({
              content: [{ type: "text" as const, text: error.message }],
              details: {
                outcome: "error",
                action: request.action,
                state,
                error: error.message,
              },
            }),
            onSuccess: result => result,
          }),
        ),
      )
    },
  })
}

export default questionsExtension
