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
import { Effect, Option, Ref } from "effect"
import { Type } from "typebox"
import { isContinuationPaused } from "../shared/continuation-pause.ts"
import {
  QUESTION_ASK_EVENT,
  type UserQuestionRequest,
} from "../shared/question-events.ts"
import {
  AUTO_RELOAD_PENDING_REQUEST_EVENT,
  type AutoReloadPendingReporter,
} from "../shared/reload-events.ts"
import { registerRuntimeVersion } from "../shared/runtime-version.ts"
import { KANBAN_OVERLAY_OPTIONS, KanbanComponent } from "./kanban.ts"
import {
  CONTENT_GUTTER,
  frameTaskHud,
  overlayRule,
  taskHud,
  todoSummary,
} from "./presentation.ts"
import {
  decodeTodoDetails,
  decodeTodoState,
  emptyTodoState,
  nextDeferredReminderAt,
  parseTodoAction,
  transitionTodoState,
  todoStatusMark,
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
    "add",
    "toggle",
    "status",
    "block",
    "reply",
    "unblock",
    "clear",
  ] as const),
  text: Type.Optional(
    Type.String({ description: "Todo text (for add or reply)" }),
  ),
  id: Type.Optional(Type.Number({ description: "Todo ID" })),
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
  | "success"
  | "warning"
  | "accent"
  | "toolTitle"
  | "dim"
  | "muted"

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

class TaskHudComponent {
  private readonly state: TodoState
  private readonly theme: Theme

  constructor(state: TodoState, theme: Theme) {
    this.state = state
    this.theme = theme
  }

  private colorTaskHeadline(line: string): string {
    const progressBar = /([▰▱]{8})/u
    return line
      .split(progressBar)
      .map((part) =>
        progressBar.test(part)
          ? this.theme.fg("accent", part)
          : this.theme.fg("borderAccent", part),
      )
      .join("")
  }

  private colorTaskRow(line: string): string {
    const firstBorder = line.indexOf("│")
    const lastBorder = line.lastIndexOf("│")
    if (firstBorder < 0 || lastBorder <= firstBorder) {
      return this.theme.fg("accent", line)
    }

    return [
      this.theme.fg("borderAccent", line.slice(0, firstBorder + 1)),
      this.theme.fg("accent", line.slice(firstBorder + 1, lastBorder)),
      this.theme.fg("borderAccent", line.slice(lastBorder)),
    ].join("")
  }

  render(width: number): string[] {
    const hud = taskHud(this.state)
    const framed = frameTaskHud(hud, width)
    if (hud.kind === "idle") {
      const [headline = "", row = ""] = framed
      return [
        this.theme.bold(this.colorTaskHeadline(headline)),
        this.colorTaskRow(row),
      ]
    }

    const [headline, ...rows] = framed

    return [
      this.theme.bold(this.colorTaskHeadline(headline ?? "")),
      ...rows.map((row) => this.colorTaskRow(row)),
    ]
  }

  invalidate(): void {}
}

class TodoListComponent {
  private cachedWidth?: number
  private cachedLines?: string[]

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
        const id = this.theme.fg("accent", `#${todo.id}`)
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
const TODO_REMINDER_MESSAGE = "todo.reminder"
const MAX_TIMER_DELAY_MS = 2_147_483_647

function restoredState(ctx: ExtensionContext): TodoState {
  const states = ctx.sessionManager.getBranch().flatMap((entry) => {
    if (entry.type === "custom" && entry.customType === TODO_STATE_ENTRY) {
      return Option.toArray(decodeTodoState(entry.data))
    }
    if (
      entry.type !== "message" ||
      entry.message.role !== "toolResult" ||
      entry.message.toolName !== "todo"
    )
      return []
    return Option.toArray(decodeTodoDetails(entry.message.details)).map(
      ({ state }) => state,
    )
  })
  return states.at(-1) ?? emptyTodoState
}

export default function todoExtension(pi: ExtensionAPI): void {
  registerRuntimeVersion(pi, "todo", "2026.07.23.22")
  const stateRef = Effect.runSync(Ref.make<TodoState>(emptyTodoState))
  let hudExpiry: ReturnType<typeof setTimeout> | undefined
  let reminderTimer: ReturnType<typeof setTimeout> | undefined

  const renderTaskWidget = (
    ctx: ExtensionContext,
    state = Effect.runSync(Ref.get(stateRef)),
  ) => {
    if (!ctx.hasUI) return
    const summary = todoSummary(state)
    ctx.ui.setStatus(
      "todo",
      summary.total > 0
        ? `tasks:${summary.pending}/${summary.total}`
        : undefined,
    )
    // Always mounted: a session with no tasks collapses to one rule so panes
    // sitting side by side keep the same chrome instead of one losing its HUD.
    ctx.ui.setWidget(
      "todo-top-tasks",
      (_tui, theme) => new TaskHudComponent(state, theme),
      {
        placement: "aboveEditor",
      },
    )

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

  const autoReloadPending = (): boolean => {
    let pending = false
    const report: AutoReloadPendingReporter = (value) => {
      pending ||= value
    }
    pi.events.emit(AUTO_RELOAD_PENDING_REQUEST_EVENT, report)
    return pending
  }

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
    const current = Effect.runSync(Ref.get(stateRef))
    const wake = wakeDueDeferredTodos(current, Date.now())
    if (wake.woken.length === 0) {
      scheduleReminder(ctx, current)
      return
    }
    if (
      isContinuationPaused(ctx.sessionManager.getBranch()) ||
      !ctx.isIdle() ||
      ctx.hasPendingMessages() ||
      autoReloadPending()
    )
      return

    Effect.runSync(Ref.set(stateRef, wake.state))
    pi.appendEntry(TODO_STATE_ENTRY, wake.state)
    renderTaskWidget(ctx, wake.state)
    scheduleReminder(ctx, wake.state)
    const due = wake.woken.map(({ id, text }) => `- #${id}: ${text}`).join("\n")
    pi.sendMessage(
      {
        customType: TODO_REMINDER_MESSAGE,
        content: `Scheduled todo reminder due:\n${due}\nResume these tracked tasks under current authorization; the reminder grants no new authority.`,
        display: true,
      },
      { triggerTurn: true, deliverAs: "followUp" },
    )
    if (ctx.hasUI)
      ctx.ui.notify(
        `${wake.woken.length} deferred todo reminder(s) due.`,
        "info",
      )
  }

  const reconstructState = (ctx: ExtensionContext) =>
    Ref.set(stateRef, restoredState(ctx))
  const reconstructAndRender = async (ctx: ExtensionContext) => {
    await Effect.runPromise(reconstructState(ctx))
    const state = Effect.runSync(Ref.get(stateRef))
    pi.appendEntry(TODO_STATE_ENTRY, state)
    renderTaskWidget(ctx, state)
    scheduleReminder(ctx, state)
    await wakeDueReminders(ctx)
  }
  pi.on("session_start", async (_event, ctx) => reconstructAndRender(ctx))
  pi.on("session_tree", async (_event, ctx) => reconstructAndRender(ctx))
  pi.on("session_compact", async (_event, ctx) => {
    const state = Effect.runSync(Ref.get(stateRef))
    pi.appendEntry(TODO_STATE_ENTRY, state)
    renderTaskWidget(ctx, state)
    scheduleReminder(ctx, state)
    await wakeDueReminders(ctx)
  })
  pi.on("session_shutdown", (_event, ctx) => {
    if (hudExpiry) clearTimeout(hudExpiry)
    if (reminderTimer) clearTimeout(reminderTimer)
    hudExpiry = undefined
    reminderTimer = undefined
    ctx.ui.setStatus("todo", undefined)
    ctx.ui.setWidget("todo-top-tasks", undefined)
  })

  const applyUiAction = async (
    action: TodoAction,
    ctx: ExtensionContext,
  ): Promise<TodoState> => {
    const current = Effect.runSync(Ref.get(stateRef))
    const transition = await Effect.runPromise(
      transitionTodoState(current, action, Date.now()),
    )
    await Effect.runPromise(Ref.set(stateRef, transition.state))
    pi.appendEntry(TODO_STATE_ENTRY, transition.state)
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
          selectedPrefix: (text) => theme.fg("accent", text),
          selectedText: (text) => theme.fg("accent", text),
          description: (text) => theme.fg("muted", text),
          scrollInfo: (text) => theme.fg("dim", text),
          noMatch: (text) => theme.fg("warning", text),
        })
        list.onSelect = (item) =>
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
              `${theme.bold("Replies")}\n${todo.replies.map((reply) => theme.fg("muted", `↳ ${reply}`)).join("\n")}`,
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

  pi.registerTool({
    name: "todo",
    label: "Todo",
    description:
      "Manage a branch-aware todo list. Actions: list, add, toggle, status (id + status; optional remindAt for deferred), block (id + reason), reply (id + text), unblock, clear",
    parameters: TodoParams,

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const program = Ref.get(stateRef).pipe(
        Effect.flatMap((state) =>
          parseTodoAction(params, Date.now()).pipe(
            Effect.flatMap((action) =>
              transitionTodoState(state, action, Date.now()),
            ),
            Effect.tap(({ state: nextState }) => Ref.set(stateRef, nextState)),
            Effect.map((transition) =>
              successfulToolResult(
                transition.action,
                transition.state,
                transition.message,
              ),
            ),
            Effect.catchTags({
              TodoInputError: (error) =>
                Effect.succeed(
                  failedToolResult(error.action, state, error.message),
                ),
              TodoNotFoundError: (error) =>
                Effect.succeed(
                  failedToolResult(error.action, state, error.message),
                ),
            }),
          ),
        ),
      )
      const result = await Effect.runPromise(program)
      if (result.details.outcome === "success")
        pi.appendEntry(TODO_STATE_ENTRY, result.details.state)
      renderTaskWidget(ctx, result.details.state)
      scheduleReminder(ctx, result.details.state)
      return result
    },

    renderCall(args, theme) {
      let text =
        theme.fg("toolTitle", theme.bold("todo ")) +
        theme.fg("muted", args.action)
      if (args.text) text += ` ${theme.fg("dim", `"${args.text}"`)}`
      if (args.id !== undefined) text += ` ${theme.fg("accent", `#${args.id}`)}`
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
              ?.map(
                (reply) => `\n    ${theme.fg("accent", "↳ reply:")} ${reply}`,
              )
              .join("") ?? ""
          text += `\n${check} ${theme.fg("accent", `#${todo.id}`)} ${theme.fg(completed ? "dim" : "muted", label)}${replies}`
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
        (todo) =>
          `#${todo.id}  ${todo.text.replace(/\s+/g, " ").slice(0, 100)}`,
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
        await applyUiAction({ action: "unblock", id: todo.id }, ctx)
        ctx.ui.notify(`Todo #${todo.id} unblocked.`, "info")
        return
      }
      if (action === "resolve") {
        await applyUiAction({ action: "unblock", id: todo.id }, ctx)
        await applyUiAction({ action: "toggle", id: todo.id }, ctx)
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
        await applyUiAction(
          { action: "reply", id: todo.id, text: reply.trim() },
          ctx,
        )
        if (disposition === "Reply and unblock")
          await applyUiAction({ action: "unblock", id: todo.id }, ctx)
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
        await applyUiAction(
          { action: "block", id: todo.id, reason: reason.trim() },
          ctx,
        )
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
      if (ctx.mode !== "tui") {
        ctx.ui.notify("/kanban requires interactive mode", "error")
        return
      }
      const state = Effect.runSync(Ref.get(stateRef))
      await ctx.ui.custom<void>(
        (_tui, theme, _kb, done) =>
          new KanbanComponent(state, theme, () => done()),
        {
          overlay: true,
          overlayOptions: KANBAN_OVERLAY_OPTIONS,
        },
      )
    },
  })

  pi.on("agent_settled", async (_event, ctx) => wakeDueReminders(ctx))
}
