/**
 * Adapted from diegopetrucci/pi-extensions at
 * 966ac95f8d717be6f763c62c88f4beb92b6554d3. The branch-aware session storage
 * and defensive immutable snapshots are preserved; state and failures are
 * modeled with Effect.
 */

import { StringEnum } from "@earendil-works/pi-ai"
import {
  DynamicBorder,
  type ExtensionAPI,
  type ExtensionContext,
  type Theme,
} from "@earendil-works/pi-coding-agent"
import {
  Container,
  matchesKey,
  type SelectItem,
  SelectList,
  Text,
  truncateToWidth,
} from "@earendil-works/pi-tui"
import { Effect, Either, Option, Ref } from "effect"
import { Type } from "typebox"
import { BRANCH_TODO_BACKLOG_EVENT } from "../shared/backlog-events.ts"
import { branchTodoBacklogSnapshot } from "./backlog-adapter.ts"
import {
  QUESTION_ASK_EVENT,
  type UserQuestionRequest,
} from "../shared/question-events.ts"
import { registerRuntimeVersion } from "../shared/runtime-version.ts"
import { registerTodoControl } from "./control.ts"
import {
  invokeManagerTodo,
  type ManagerTodoRuntime,
} from "../classified-workflows/manager-client.ts"
import { getManagerBinding } from "../shared/manager-binding.ts"
import { KANBAN_OVERLAY_OPTIONS, KanbanComponent } from "./kanban.ts"
import {
  CONTENT_GUTTER,
  overlayRule,
  shouldShowTaskHud,
  toggleTaskHudVisibility,
  todoSummary,
  type TaskHudVisibility,
} from "./presentation.ts"
import { TaskHudComponent } from "./task-hud.ts"
import {
  decodeTodoDetails,
  decodeTodoState,
  emptyTodoState,
  nextDeferredReminderAt,
  parseTodoAction,
  transitionTodoState,
  validateTodoState,
  TodoInputError,
  todoStatusMark,
  todoIdentityLabel,
  wakeDueDeferredTodos,
  type Todo,
  type TodoAction,
  type TodoDetails,
  type TodoState,
  type TodoStatus,
} from "./state.ts"

const TodoParams = Type.Object({
  action: StringEnum([
    "list",
    "priority",
    "add",
    "toggle",
    "status",
    "block",
    "reply",
    "unblock",
    "clear",
  ] as const),
  text: Type.Optional(
    Type.String({
      description:
        "Todo text; replies are limited to 3 entries of at most 300 characters",
    }),
  ),
  id: Type.Optional(Type.Number({ description: "Todo ID" })),
  priority: Type.Optional(
    Type.Union([
      Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
      Type.Null(),
    ]),
  ),
  parentId: Type.Optional(
    Type.Integer({
      minimum: 1,
      description: "Existing root todo ID for add; one level of subtasks only",
    }),
  ),
  status: Type.Optional(
    StringEnum([
      "pending",
      "in_progress",
      "in_review",
      "completed",
      "cancelled",
      "deferred",
    ] as const),
  ),
  reason: Type.Optional(
    Type.String({ description: "Required blocker reason for block" }),
  ),
  remindAt: Type.Optional(
    Type.String({
      description:
        "Timezone-qualified ISO-8601 wake time; only with status=deferred",
    }),
  ),
})

type StatusColor =
  "success" | "warning" | "accent" | "toolTitle" | "dim" | "muted"

const statusColor = (status: TodoStatus | undefined): StatusColor => {
  switch (status) {
    case "completed":
      return "success"
    case "blocked":
      return "warning"
    case "in_progress":
      return "accent"
    case "in_review":
      return "toolTitle"
    case "deferred":
      return "muted"
    case "cancelled":
      return "dim"
    default:
      return "accent"
  }
}

class TodoListComponent {
  private cachedWidth: number | undefined
  private cachedLines: string[] | undefined

  constructor(
    private readonly todos: ReadonlyArray<Todo>,
    private readonly theme: Theme,
    private readonly onClose: () => void,
  ) {}

  handleInput(data: string): void {
    if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) this.onClose()
  }

  render(width: number): string[] {
    if (this.cachedLines && this.cachedWidth === width) return this.cachedLines

    const lines: string[] = []
    const completed = this.todos.filter(
      ({ status }) => status === "completed",
    ).length
    const blocked = this.todos.filter(
      ({ status }) => status === "blocked",
    ).length
    const header = overlayRule(
      {
        left: "TODOS",
        right:
          this.todos.length === 0
            ? ""
            : `${completed}/${this.todos.length} complete  ·  ${blocked} blocked`,
      },
      width,
    )
    lines.push("", this.theme.bold(this.theme.fg("borderAccent", header)), "")

    if (this.todos.length === 0) {
      lines.push(
        truncateToWidth(
          `${CONTENT_GUTTER}${this.theme.fg("dim", "No todos yet. Ask the agent to add some!")}`,
          width,
        ),
      )
    } else {
      for (const todo of this.todos) {
        const isCompleted = todo.status === "completed"
        const isBlocked = todo.status === "blocked"
        const check = this.theme.fg(
          statusColor(todo.status),
          todoStatusMark(todo.status),
        )
        const id = this.theme.fg("accent", todoIdentityLabel(todo))
        const label = isBlocked
          ? `${todo.text} — blocked: ${todo.reason}`
          : todo.status === "deferred" && todo.remindAt !== undefined
            ? `${todo.text} — until ${new Date(todo.remindAt).toISOString()}`
            : todo.text
        const text = this.theme.fg(isCompleted ? "dim" : "text", label)
        lines.push(
          truncateToWidth(`${CONTENT_GUTTER}${check} ${id} ${text}`, width),
        )
      }
    }

    lines.push(
      "",
      truncateToWidth(
        `${CONTENT_GUTTER}${this.theme.fg("dim", "Press Escape to close")}`,
        width,
      ),
      "",
    )
    this.cachedWidth = width
    this.cachedLines = lines
    return lines
  }

  invalidate(): void {
    this.cachedWidth = undefined
    this.cachedLines = undefined
  }
}

function successfulToolResult(
  action: TodoAction["action"],
  state: TodoState,
  message: string,
) {
  const details: TodoDetails = { outcome: "success", action, state }
  return { content: [{ type: "text" as const, text: message }], details }
}

function failedToolResult(
  action: TodoAction["action"],
  state: TodoState,
  error: string,
) {
  const details: TodoDetails = { outcome: "error", action, state, error }
  return {
    content: [{ type: "text" as const, text: `Error: ${error}` }],
    details,
  }
}

const TODO_STATE_ENTRY = "todo.state"
const MAX_TIMER_DELAY_MS = 2_147_483_647

const restoredState = (
  ctx: ExtensionContext,
): Effect.Effect<TodoState, TodoInputError> => {
  const snapshots = ctx.sessionManager.getBranch().flatMap(entry => {
    if (entry.type === "custom" && entry.customType === TODO_STATE_ENTRY)
      return [{ data: entry.data }]
    if (
      entry.type !== "message" ||
      entry.message.role !== "toolResult" ||
      entry.message.toolName !== "todo"
    )
      return []
    const details = entry.message.details
    return typeof details === "object" && details !== null && "state" in details
      ? [{ data: details.state }]
      : []
  })
  const latest = snapshots.at(-1)
  if (!latest) return Effect.succeed(emptyTodoState)
  const decoded = decodeTodoState(latest.data)
  return Option.isSome(decoded)
    ? validateTodoState(decoded.value)
    : Effect.fail(
        new TodoInputError({
          action: "list",
          code: "invalid_state",
          message:
            "Latest branch todo snapshot is malformed; task operations are blocked without overwriting it",
        }),
      )
}

export default function todoExtension(
  pi: ExtensionAPI,
  managerRuntime?: ManagerTodoRuntime,
): void {
  registerRuntimeVersion(pi, "todo", "2026.09.13.4")
  const stateRef = Effect.runSync(Ref.make<TodoState>(emptyTodoState))
  let restorationError: string | undefined
  let hudExpiry: ReturnType<typeof setTimeout> | undefined
  let reminderTimer: ReturnType<typeof setTimeout> | undefined
  let hudVisibility: TaskHudVisibility = "visible"
  let releaseHudToggle: (() => void) | undefined

  const publishBranchTodos = (
    ctx: ExtensionContext,
    state: TodoState,
  ): void => {
    pi.events.emit(
      BRANCH_TODO_BACKLOG_EVENT,
      branchTodoBacklogSnapshot(
        ctx.cwd,
        ctx.sessionManager.getSessionId(),
        state,
        Date.now(),
      ),
    )
  }

  const mountTaskWidget = (ctx: ExtensionContext, state: TodoState): void => {
    if (!ctx.hasUI) return
    const summary = todoSummary(state)
    ctx.ui.setStatus(
      "todo",
      summary.total > 0
        ? `tasks:${summary.pending}/${summary.total}`
        : undefined,
    )
    // Unmounted whenever there is nothing tracked, or the operator hid it
    // with ctrl+t; shouldShowTaskHud is the one place these two conditions
    // combine so emptiness always wins over a stale toggle.
    ctx.ui.setWidget(
      "todo-top-tasks",
      shouldShowTaskHud(summary, hudVisibility)
        ? (tui, theme) =>
            new TaskHudComponent(state, theme, () => tui.requestRender(), {
              idle: ctx.isIdle(),
            })
        : undefined,
      {
        placement: "aboveEditor",
      },
    )
  }

  const registerHudToggle = (ctx: ExtensionContext): void => {
    if (!ctx.hasUI) return
    releaseHudToggle?.()
    releaseHudToggle = ctx.ui.onTerminalInput(data => {
      if (!matchesKey(data, "ctrl+t")) return undefined
      const state = Effect.runSync(Ref.get(stateRef))
      // Toggling while the board is empty has nothing to affect — there is no
      // widget for the preference to show or hide — so it is left untouched
      // rather than silently armed for whenever a task next appears.
      if (todoSummary(state).total > 0) {
        hudVisibility = toggleTaskHudVisibility(hudVisibility)
        renderTaskWidget(ctx, state)
      }
      return { consume: true }
    })
  }

  const renderTaskWidget = (
    ctx: ExtensionContext,
    state = Effect.runSync(Ref.get(stateRef)),
  ) => {
    if (!ctx.hasUI) return
    if (restorationError) {
      ctx.ui.setStatus("todo", "tasks:restore-blocked")
      ctx.ui.setWidget("todo-top-tasks", undefined)
      return
    }
    mountTaskWidget(ctx, state)

    if (hudExpiry) clearTimeout(hudExpiry)
    const now = Date.now()
    const nextExpiry = state.todos
      .filter(
        ({ status, statusChangedAt }) =>
          (status === "completed" || status === "cancelled") &&
          statusChangedAt !== undefined &&
          statusChangedAt + 10_000 > now,
      )
      .flatMap(({ statusChangedAt }) =>
        statusChangedAt === undefined ? [] : [statusChangedAt + 10_000 - now],
      )
      .sort((left, right) => left - right)[0]
    if (nextExpiry !== undefined) {
      hudExpiry = setTimeout(() => renderTaskWidget(ctx), nextExpiry + 25)
    }
  }

  let wakeDueReminders: (ctx: ExtensionContext) => Promise<void>

  const scheduleReminder = (
    ctx: ExtensionContext,
    state = Effect.runSync(Ref.get(stateRef)),
  ) => {
    if (reminderTimer) clearTimeout(reminderTimer)
    reminderTimer = undefined
    const nextAt = nextDeferredReminderAt(state)
    if (nextAt === undefined) return
    const delay = Math.min(Math.max(0, nextAt - Date.now()), MAX_TIMER_DELAY_MS)
    reminderTimer = setTimeout(() => {
      reminderTimer = undefined
      void wakeDueReminders(ctx)
    }, delay)
  }

  wakeDueReminders = async (ctx: ExtensionContext) => {
    if (restorationError) return
    const current = Effect.runSync(Ref.get(stateRef))
    const wake = wakeDueDeferredTodos(current, Date.now())
    if (wake.woken.length === 0) {
      scheduleReminder(ctx, current)
      return
    }
    Effect.runSync(Ref.set(stateRef, wake.state))
    pi.appendEntry(TODO_STATE_ENTRY, wake.state)
    publishBranchTodos(ctx, wake.state)
    renderTaskWidget(ctx, wake.state)
    scheduleReminder(ctx, wake.state)
    if (ctx.hasUI)
      ctx.ui.notify(
        `${wake.woken.length} deferred todo reminder(s) moved to pending.`,
        "info",
      )
  }

  const reconstructAndRender = async (ctx: ExtensionContext) => {
    const restored = await Effect.runPromise(Effect.either(restoredState(ctx)))
    if (Either.isLeft(restored)) {
      restorationError = restored.left.message
      if (reminderTimer) clearTimeout(reminderTimer)
      if (hudExpiry) clearTimeout(hudExpiry)
      ctx.ui.notify(`Cannot restore todos: ${restorationError}`, "error")
      renderTaskWidget(ctx)
      return
    }
    restorationError = undefined
    await Effect.runPromise(Ref.set(stateRef, restored.right))
    const state = restored.right
    pi.appendEntry(TODO_STATE_ENTRY, state)
    publishBranchTodos(ctx, state)
    registerHudToggle(ctx)
    renderTaskWidget(ctx, state)
    scheduleReminder(ctx, state)
    await wakeDueReminders(ctx)
  }
  pi.on("session_start", async (_event, ctx) => reconstructAndRender(ctx))
  pi.on("session_tree", async (_event, ctx) => reconstructAndRender(ctx))
  pi.on("session_compact", async (_event, ctx) => {
    if (restorationError) return
    const state = Effect.runSync(Ref.get(stateRef))
    pi.appendEntry(TODO_STATE_ENTRY, state)
    publishBranchTodos(ctx, state)
    registerHudToggle(ctx)
    renderTaskWidget(ctx, state)
    scheduleReminder(ctx, state)
    await wakeDueReminders(ctx)
  })
  pi.on("session_shutdown", (_event, ctx) => {
    if (hudExpiry) clearTimeout(hudExpiry)
    if (reminderTimer) clearTimeout(reminderTimer)
    hudExpiry = undefined
    reminderTimer = undefined
    releaseHudToggle?.()
    releaseHudToggle = undefined
    ctx.ui.setStatus("todo", undefined)
    ctx.ui.setWidget("todo-top-tasks", undefined)
  })

  const applyUiAction = async (
    action: TodoAction,
    ctx: ExtensionContext,
  ): Promise<TodoState | undefined> => {
    if (restorationError) {
      ctx.ui.notify(`Cannot change todos: ${restorationError}`, "error")
      return undefined
    }
    const current = Effect.runSync(Ref.get(stateRef))
    const result = await Effect.runPromise(
      Effect.either(transitionTodoState(current, action, Date.now())),
    )
    if (Either.isLeft(result)) {
      ctx.ui.notify(result.left.message, "error")
      return undefined
    }
    const transition = result.right
    await Effect.runPromise(Ref.set(stateRef, transition.state))
    pi.appendEntry(TODO_STATE_ENTRY, transition.state)
    publishBranchTodos(ctx, transition.state)
    renderTaskWidget(ctx, transition.state)
    scheduleReminder(ctx, transition.state)
    return transition.state
  }

  const chooseBlockedAction = (
    ctx: ExtensionContext,
    todo: Extract<Todo, { status: "blocked" }>,
  ) =>
    ctx.ui.custom<string | null>(
      (tui, theme, _keybindings, done) => {
        const items: SelectItem[] = [
          {
            value: "unblock",
            label: "Unblock",
            description: "Move back to pending work",
          },
          {
            value: "resolve",
            label: "Mark resolved",
            description: "Complete this blocked item",
          },
          {
            value: "reply",
            label: "Reply",
            description: "Attach context while preserving the original blocker",
          },
          {
            value: "edit",
            label: "Edit blocker",
            description: "Replace the blocker reason",
          },
          {
            value: "question",
            label: "Create pending question",
            description: "Queue a user decision without auto-focus",
          },
          { value: "cancel", label: "Cancel" },
        ]
        const list = new SelectList(items, items.length, {
          selectedPrefix: text => theme.fg("accent", text),
          selectedText: text => theme.fg("accent", text),
          description: text => theme.fg("muted", text),
          scrollInfo: text => theme.fg("dim", text),
          noMatch: text => theme.fg("warning", text),
        })
        list.onSelect = item =>
          done(item.value === "cancel" ? null : item.value)
        list.onCancel = () => done(null)
        const container = new Container()
        const accent = (text: string) => theme.fg("accent", text)
        container.addChild(new DynamicBorder(accent))
        container.addChild(
          new Text(theme.bold(accent(`BLOCKED #${todo.id}`)), 1, 0),
        )
        container.addChild(new Text(theme.fg("text", todo.text), 1, 1))
        container.addChild(
          new Text(
            `${theme.bold("Reason")}\n${theme.fg("warning", todo.reason)}`,
            1,
            0,
          ),
        )
        if (todo.replies && todo.replies.length > 0) {
          container.addChild(
            new Text(
              `${theme.bold("Replies")}\n${todo.replies.map(reply => theme.fg("muted", `↳ ${reply}`)).join("\n")}`,
              1,
              0,
            ),
          )
        }
        container.addChild(list)
        container.addChild(
          new Text(
            theme.fg("dim", "↑↓ select · enter apply · esc close"),
            1,
            1,
          ),
        )
        container.addChild(new DynamicBorder(accent))
        return {
          render: (width: number) => container.render(width),
          invalidate: () => container.invalidate(),
          handleInput: (data: string) => {
            list.handleInput(data)
            tui.requestRender()
          },
        }
      },
      {
        overlay: true,
        overlayOptions: {
          anchor: "center",
          width: "72%",
          minWidth: 60,
          maxHeight: "85%",
          margin: 1,
        },
      },
    )

  const executeTodo = (
    params: Parameters<typeof parseTodoAction>[0],
    ctx: ExtensionContext,
  ) => {
    if (restorationError)
      return {
        isError: true,
        content: [
          {
            type: "text" as const,
            text: `Cannot use todos: ${restorationError}`,
          },
        ],
      }
    const program = Ref.get(stateRef).pipe(
      Effect.flatMap(state =>
        parseTodoAction(params, Date.now()).pipe(
          Effect.flatMap(action =>
            transitionTodoState(state, action, Date.now()),
          ),
          Effect.map(transition =>
            successfulToolResult(
              transition.action,
              transition.state,
              transition.message,
            ),
          ),
          Effect.catchTags({
            TodoInputError: error =>
              Effect.succeed(
                failedToolResult(error.action, state, error.message),
              ),
            TodoNotFoundError: error =>
              Effect.succeed(
                failedToolResult(error.action, state, error.message),
              ),
          }),
        ),
      ),
    )
    const result = Effect.runSync(program)
    if (result.details.outcome === "success") {
      pi.appendEntry(TODO_STATE_ENTRY, result.details.state)
      Effect.runSync(Ref.set(stateRef, result.details.state))
      publishBranchTodos(ctx, result.details.state)
    }
    renderTaskWidget(ctx, result.details.state)
    scheduleReminder(ctx, result.details.state)
    return result
  }

  const releaseControl = registerTodoControl(
    pi,
    (request, ctx) => {
      const result = executeTodo(request, ctx)
      return {
        isError:
          ("isError" in result && result.isError === true) ||
          ("details" in result && result.details.outcome === "error"),
        message: result.content.map(part => part.text).join("\n"),
      }
    },
    { priority: true },
  )
  pi.on("session_shutdown", releaseControl)

  pi.registerTool({
    name: "todo",
    label: "Todo",
    description:
      "Manage branch-aware tasks. add accepts parentId for one level of subtasks; grandchildren are forbidden. reply accepts at most 3 entries of 300 characters; restructure at the cap. priority sets an independent positive safe-integer rank (lower first), or null to unassign, without changing status. Other actions: list, toggle, status, block, unblock, clear.",
    parameters: TodoParams,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const binding = getManagerBinding(pi, ctx)
      if (Either.isLeft(binding) || binding.right.role !== "worker")
        return invokeManagerTodo(pi, ctx, params, signal, managerRuntime)
      return executeTodo(params, ctx)
    },

    renderCall(args, theme) {
      let text =
        theme.fg("toolTitle", theme.bold("todo ")) +
        theme.fg("muted", args.action)
      if (args.text) text += ` ${theme.fg("dim", `"${args.text}"`)}`
      if (args.id !== undefined) text += ` ${theme.fg("accent", `#${args.id}`)}`
      if (args.parentId !== undefined)
        text += ` ${theme.fg("accent", `subtask of #${args.parentId}`)}`
      if (args.status) text += ` ${theme.fg("accent", args.status)}`
      if (args.reason)
        text += ` ${theme.fg("warning", `blocked: ${args.reason}`)}`
      if (args.remindAt)
        text += ` ${theme.fg("accent", `until ${args.remindAt}`)}`
      return new Text(text, 0, 0)
    },

    renderResult(result, { expanded }, theme) {
      const details = Option.getOrUndefined(decodeTodoDetails(result.details))
      if (!details) {
        const content = result.content[0]
        return new Text(content?.type === "text" ? content.text : "", 0, 0)
      }
      if (details.outcome === "error")
        return new Text(theme.fg("error", `Error: ${details.error}`), 0, 0)

      if (details.action === "list") {
        if (details.state.todos.length === 0)
          return new Text(theme.fg("dim", "No todos"), 0, 0)
        const visible = expanded
          ? details.state.todos
          : details.state.todos.slice(0, 5)
        let text = theme.fg("muted", `${details.state.todos.length} todo(s):`)
        for (const todo of visible) {
          const completed = todo.status === "completed"
          const blocked = todo.status === "blocked"
          const color: "success" | "warning" | "accent" | "toolTitle" | "dim" =
            completed
              ? "success"
              : blocked
                ? "warning"
                : todo.status === "in_progress"
                  ? "accent"
                  : todo.status === "in_review"
                    ? "toolTitle"
                    : "dim"
          const check = theme.fg(color, todoStatusMark(todo.status))
          const label = blocked
            ? `${todo.text} — blocked: ${todo.reason}`
            : todo.status === "deferred" && todo.remindAt !== undefined
              ? `${todo.text} — until ${new Date(todo.remindAt).toISOString()}`
              : todo.text
          const replies =
            todo.replies
              ?.map(reply => `\n    ${theme.fg("accent", "↳ reply:")} ${reply}`)
              .join("") ?? ""
          text += `\n${check} ${theme.fg("accent", todoIdentityLabel(todo))} ${theme.fg(completed ? "dim" : "muted", label)}${replies}`
        }
        if (!expanded && details.state.todos.length > visible.length) {
          text += `\n${theme.fg("dim", `... ${details.state.todos.length - visible.length} more`)}`
        }
        return new Text(text, 0, 0)
      }

      const content = result.content[0]
      const message = content?.type === "text" ? content.text : "Done"
      return new Text(
        theme.fg("success", "✓ ") + theme.fg("muted", message),
        0,
        0,
      )
    },
  })

  pi.registerCommand("todos", {
    description: "Show all todos on the current branch",
    handler: async (_args, ctx) => {
      if (restorationError) {
        ctx.ui.notify(restorationError, "error")
        return
      }
      if (ctx.mode !== "tui") {
        ctx.ui.notify("/todos requires interactive mode", "error")
        return
      }
      const state = Effect.runSync(Ref.get(stateRef))
      await ctx.ui.custom<void>(
        (_tui, theme, _kb, done) =>
          new TodoListComponent(state.todos, theme, () => done()),
      )
    },
  })

  pi.registerCommand("blocked", {
    description:
      "Triage blocked todos without auto-focusing normal prompt input",
    handler: async (_args, ctx) => {
      if (restorationError) {
        ctx.ui.notify(restorationError, "error")
        return
      }
      if (ctx.mode !== "tui") {
        ctx.ui.notify("/blocked requires interactive mode", "error")
        return
      }
      const state = Effect.runSync(Ref.get(stateRef))
      const blocked = state.todos.filter(
        (todo): todo is Extract<Todo, { status: "blocked" }> =>
          todo.status === "blocked",
      )
      if (blocked.length === 0) {
        ctx.ui.notify("No blocked todos.", "info")
        return
      }
      const choices = blocked.map(
        todo => `#${todo.id}  ${todo.text.replace(/\s+/g, " ").slice(0, 100)}`,
      )
      const selected = await ctx.ui.select(
        "Blocked todos · select one to triage",
        choices,
      )
      if (selected === undefined) return
      const todo = blocked[choices.indexOf(selected)]
      if (!todo) return
      const action = await chooseBlockedAction(ctx, todo)
      if (!action) return

      if (action === "unblock") {
        if (!(await applyUiAction({ action: "unblock", id: todo.id }, ctx)))
          return
        ctx.ui.notify(`Todo #${todo.id} unblocked.`, "info")
        return
      }
      if (action === "resolve") {
        if (!(await applyUiAction({ action: "unblock", id: todo.id }, ctx)))
          return
        if (!(await applyUiAction({ action: "toggle", id: todo.id }, ctx)))
          return
        ctx.ui.notify(`Todo #${todo.id} resolved.`, "info")
        return
      }
      if (action === "reply") {
        const reply = await ctx.ui.input(
          `Reply to blocker #${todo.id}`,
          "Add context or answer the blocker",
        )
        if (!reply?.trim()) return
        const disposition = await ctx.ui.select("After attaching this reply", [
          "Keep blocked",
          "Reply and unblock",
        ])
        if (disposition === undefined) return
        if (
          !(await applyUiAction(
            { action: "reply", id: todo.id, text: reply.trim() },
            ctx,
          ))
        )
          return
        if (
          disposition === "Reply and unblock" &&
          !(await applyUiAction({ action: "unblock", id: todo.id }, ctx))
        )
          return
        ctx.ui.notify(
          disposition === "Reply and unblock"
            ? `Reply attached and todo #${todo.id} unblocked.`
            : `Reply attached to blocked todo #${todo.id}.`,
          "info",
        )
        return
      }
      if (action === "edit") {
        const reason = await ctx.ui.input(
          `New blocker reason for #${todo.id}`,
          todo.reason,
        )
        if (!reason?.trim()) return
        if (
          !(await applyUiAction(
            { action: "block", id: todo.id, reason: reason.trim() },
            ctx,
          ))
        )
          return
        ctx.ui.notify(`Todo #${todo.id} blocker updated.`, "info")
        return
      }
      const decision = await ctx.ui.input(
        `Question needed to unblock #${todo.id}`,
        "What decision or information is needed?",
      )
      if (!decision?.trim()) return
      const request: UserQuestionRequest = {
        header: "Blocked todo",
        question: `Blocked todo #${todo.id}: ${todo.text}\nCurrent blocker: ${todo.reason}\nDecision needed: ${decision.trim()}`,
      }
      pi.events.emit(QUESTION_ASK_EVENT, request)
      ctx.ui.notify(`Queued a pending question for todo #${todo.id}.`, "info")
    },
  })

  pi.registerCommand("kanban", {
    description:
      "Open a right-side task board overlay while keeping the session visible",
    handler: async (_args, ctx) => {
      if (restorationError) {
        ctx.ui.notify(restorationError, "error")
        return
      }
      if (ctx.mode !== "tui") {
        ctx.ui.notify("/kanban requires interactive mode", "error")
        return
      }
      const state = Effect.runSync(Ref.get(stateRef))
      await ctx.ui.custom<void>(
        (tui, theme, _kb, done) =>
          new KanbanComponent(
            state,
            theme,
            () => done(),
            () => tui.requestRender(),
            async todo => {
              const next = await applyUiAction(
                { action: "unblock", id: todo.id },
                ctx,
              )
              if (next) ctx.ui.notify(`Todo #${todo.id} unblocked.`, "info")
              return next
            },
          ),
        {
          overlay: true,
          overlayOptions: KANBAN_OVERLAY_OPTIONS,
        },
      )
    },
  })

  pi.on("agent_start", (_event, ctx) => {
    renderTaskWidget(ctx)
  })

  pi.on("agent_settled", async (_event, ctx) => {
    renderTaskWidget(ctx)
    await wakeDueReminders(ctx)
  })
}
