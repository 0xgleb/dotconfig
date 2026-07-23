/**
 * Adapted from diegopetrucci/pi-extensions at
 * 966ac95f8d717be6f763c62c88f4beb92b6554d3. The branch-aware session storage
 * and defensive immutable snapshots are preserved; state and failures are
 * modeled with Effect.
 */

import { StringEnum } from "@earendil-works/pi-ai";
import { DynamicBorder, type ExtensionAPI, type ExtensionContext, type Theme } from "@earendil-works/pi-coding-agent";
import { Container, matchesKey, type SelectItem, SelectList, Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { Effect, Option, Ref } from "effect";
import { Type } from "typebox";
import { QUESTION_ASK_EVENT, type UserQuestionRequest } from "../shared/question-events.ts";
import { registerRuntimeVersion } from "../shared/runtime-version.ts";
import { kanbanColumns, taskWidgetLines, todoSummary } from "./presentation.ts";
import {
  decodeTodoDetails,
  decodeTodoState,
  emptyTodoState,
  parseTodoAction,
  transitionTodoState,
  type Todo,
  type TodoAction,
  type TodoDetails,
  type TodoState,
} from "./state.ts";

const TodoParams = Type.Object({
  action: StringEnum(["list", "add", "toggle", "block", "unblock", "clear"] as const),
  text: Type.Optional(Type.String({ description: "Todo text (for add)" })),
  id: Type.Optional(Type.Number({ description: "Todo ID (for toggle, block, or unblock)" })),
  reason: Type.Optional(Type.String({ description: "Required blocker reason for block" })),
});

class TodoListComponent {
  private cachedWidth?: number;
  private cachedLines?: string[];

  constructor(
    private readonly todos: ReadonlyArray<Todo>,
    private readonly theme: Theme,
    private readonly onClose: () => void,
  ) {}

  handleInput(data: string): void {
    if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) this.onClose();
  }

  render(width: number): string[] {
    if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;

    const lines: string[] = [];
    const title = this.theme.fg("accent", " Todos ");
    const header =
      this.theme.fg("borderMuted", "─".repeat(3)) +
      title +
      this.theme.fg("borderMuted", "─".repeat(Math.max(0, width - 10)));
    lines.push("", truncateToWidth(header, width), "");

    if (this.todos.length === 0) {
      lines.push(truncateToWidth(`  ${this.theme.fg("dim", "No todos yet. Ask the agent to add some!")}`, width));
    } else {
      const completed = this.todos.filter(({ status }) => status === "completed").length;
      const blocked = this.todos.filter(({ status }) => status === "blocked").length;
      lines.push(
        truncateToWidth(
          `  ${this.theme.fg("muted", `${completed}/${this.todos.length} completed · ${blocked} blocked`)}`,
          width,
        ),
        "",
      );
      for (const todo of this.todos) {
        const isCompleted = todo.status === "completed";
        const isBlocked = todo.status === "blocked";
        const check = isCompleted
          ? this.theme.fg("success", "✓")
          : isBlocked
            ? this.theme.fg("warning", "⊘")
            : this.theme.fg("dim", "○");
        const id = this.theme.fg("accent", `#${todo.id}`);
        const label = isBlocked ? `${todo.text} — blocked: ${todo.reason}` : todo.text;
        const text = this.theme.fg(isCompleted ? "dim" : "text", label);
        lines.push(truncateToWidth(`  ${check} ${id} ${text}`, width));
      }
    }

    lines.push("", truncateToWidth(`  ${this.theme.fg("dim", "Press Escape to close")}`, width), "");
    this.cachedWidth = width;
    this.cachedLines = lines;
    return lines;
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
  }
}

class KanbanComponent {
  private cachedWidth?: number;
  private cachedLines?: string[];

  constructor(
    private readonly state: TodoState,
    private readonly theme: Theme,
    private readonly onClose: () => void,
  ) {}

  handleInput(data: string): void {
    if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) this.onClose();
  }

  render(width: number): string[] {
    if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;

    const summary = todoSummary(this.state);
    const columns = kanbanColumns(this.state);
    const separator = this.theme.fg("borderMuted", " │ ");
    const available = Math.max(3, width - 6);
    const baseWidth = Math.floor(available / 3);
    const columnWidths = [baseWidth, baseWidth, available - baseWidth * 2] as const;
    const now = this.cardLines(columns.now, "●", "warning", 18, "Nothing active");
    const next = this.cardLines(columns.next, "○", "accent", 18, "Queue clear");
    const done = this.cardLines(columns.done.slice().reverse(), "✓", "success", 18, "Nothing done yet");
    const rowCount = Math.max(now.length, next.length, done.length);
    const lines = [
      "",
      truncateToWidth(
        `${this.theme.fg("accent", this.theme.bold("KANBAN"))}  ${this.theme.fg("muted", `${summary.completed}/${summary.total} complete · ${summary.pending} active · ${summary.blocked} blocked`)}`,
        width,
      ),
      "",
      this.row(
        [
          this.theme.fg("warning", this.theme.bold("NOW")),
          this.theme.fg("accent", this.theme.bold("NEXT")),
          this.theme.fg("success", this.theme.bold("DONE")),
        ],
        columnWidths,
        separator,
      ),
      this.row(columnWidths.map((columnWidth) => this.theme.fg("borderMuted", "─".repeat(columnWidth))), columnWidths, separator),
    ];

    for (let index = 0; index < rowCount; index += 1) {
      lines.push(this.row([now[index] ?? "", next[index] ?? "", done[index] ?? ""], columnWidths, separator));
    }

    lines.push("", truncateToWidth(this.theme.fg("dim", "Esc closes · session remains visible behind this board"), width), "");
    this.cachedWidth = width;
    this.cachedLines = lines;
    return lines;
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
  }

  private cardLines(
    todos: ReadonlyArray<Todo>,
    icon: string,
    color: "accent" | "success" | "warning",
    limit: number,
    emptyLabel: string,
  ): string[] {
    if (todos.length === 0) return [this.theme.fg("dim", emptyLabel)];
    const visible = todos.slice(0, limit).map(
      (todo) => `${this.theme.fg(color, icon)} ${this.theme.fg("accent", `#${todo.id}`)} ${todo.text}`,
    );
    if (todos.length > visible.length) visible.push(this.theme.fg("dim", `… ${todos.length - visible.length} more`));
    return visible;
  }

  private row(cells: readonly string[], widths: readonly [number, number, number], separator: string): string {
    return cells.map((cell, index) => this.padCell(cell, widths[index] ?? 0)).join(separator);
  }

  private padCell(content: string, width: number): string {
    const truncated = truncateToWidth(content, width, "");
    return truncated + " ".repeat(Math.max(0, width - visibleWidth(truncated)));
  }
}

function successfulToolResult(action: TodoAction["action"], state: TodoState, message: string) {
  const details: TodoDetails = { outcome: "success", action, state };
  return { content: [{ type: "text" as const, text: message }], details };
}

function failedToolResult(action: TodoAction["action"], state: TodoState, error: string) {
  const details: TodoDetails = { outcome: "error", action, state, error };
  return { content: [{ type: "text" as const, text: `Error: ${error}` }], details };
}

const TODO_STATE_ENTRY = "todo.state";

function restoredState(ctx: ExtensionContext): TodoState {
  const states = ctx.sessionManager.getBranch().flatMap((entry) => {
    if (entry.type === "custom" && entry.customType === TODO_STATE_ENTRY) {
      return Option.toArray(decodeTodoState(entry.data));
    }
    if (entry.type !== "message" || entry.message.role !== "toolResult" || entry.message.toolName !== "todo") return [];
    return Option.toArray(decodeTodoDetails(entry.message.details)).map(({ state }) => state);
  });
  return states.at(-1) ?? emptyTodoState;
}

export default function todoExtension(pi: ExtensionAPI): void {
  registerRuntimeVersion(pi, "todo", "2026.07.23.3");
  const stateRef = Effect.runSync(Ref.make<TodoState>(emptyTodoState));

  const renderTaskWidget = (ctx: ExtensionContext, state = Effect.runSync(Ref.get(stateRef))) => {
    if (!ctx.hasUI) return;
    const summary = todoSummary(state);
    ctx.ui.setStatus("todo", summary.total > 0 ? `tasks:${summary.pending}/${summary.total}` : undefined);
    const lines = taskWidgetLines(state);
    ctx.ui.setWidget("todo-top-tasks", lines.length > 0 ? lines : undefined, { placement: "aboveEditor" });
  };

  const reconstructState = (ctx: ExtensionContext) => Ref.set(stateRef, restoredState(ctx));
  const reconstructAndRender = async (ctx: ExtensionContext) => {
    await Effect.runPromise(reconstructState(ctx));
    const state = Effect.runSync(Ref.get(stateRef));
    pi.appendEntry(TODO_STATE_ENTRY, state);
    renderTaskWidget(ctx, state);
  };
  pi.on("session_start", async (_event, ctx) => reconstructAndRender(ctx));
  pi.on("session_tree", async (_event, ctx) => reconstructAndRender(ctx));
  pi.on("session_compact", (_event, ctx) => {
    const state = Effect.runSync(Ref.get(stateRef));
    pi.appendEntry(TODO_STATE_ENTRY, state);
    renderTaskWidget(ctx, state);
  });

  const applyUiAction = async (action: TodoAction, ctx: ExtensionContext): Promise<TodoState> => {
    const current = Effect.runSync(Ref.get(stateRef));
    const transition = await Effect.runPromise(transitionTodoState(current, action));
    await Effect.runPromise(Ref.set(stateRef, transition.state));
    pi.appendEntry(TODO_STATE_ENTRY, transition.state);
    renderTaskWidget(ctx, transition.state);
    return transition.state;
  };

  const chooseBlockedAction = (ctx: ExtensionContext, todo: Extract<Todo, { status: "blocked" }>) =>
    ctx.ui.custom<string | null>(
      (tui, theme, _keybindings, done) => {
        const items: SelectItem[] = [
          { value: "unblock", label: "Unblock", description: "Move back to pending work" },
          { value: "resolve", label: "Mark resolved", description: "Complete this blocked item" },
          { value: "edit", label: "Edit blocker", description: "Replace the blocker reason" },
          { value: "question", label: "Create pending question", description: "Queue a user decision without auto-focus" },
          { value: "cancel", label: "Cancel" },
        ];
        const list = new SelectList(items, items.length, {
          selectedPrefix: (text) => theme.fg("accent", text),
          selectedText: (text) => theme.fg("accent", text),
          description: (text) => theme.fg("muted", text),
          scrollInfo: (text) => theme.fg("dim", text),
          noMatch: (text) => theme.fg("warning", text),
        });
        list.onSelect = (item) => done(item.value === "cancel" ? null : item.value);
        list.onCancel = () => done(null);
        const container = new Container();
        const accent = (text: string) => theme.fg("accent", text);
        container.addChild(new DynamicBorder(accent));
        container.addChild(new Text(theme.bold(accent(`BLOCKED #${todo.id}`)), 1, 0));
        container.addChild(new Text(theme.fg("text", todo.text), 1, 1));
        container.addChild(new Text(`${theme.bold("Reason")}\n${theme.fg("warning", todo.reason)}`, 1, 0));
        container.addChild(list);
        container.addChild(new Text(theme.fg("dim", "↑↓ select · enter apply · esc close"), 1, 1));
        container.addChild(new DynamicBorder(accent));
        return {
          render: (width: number) => container.render(width),
          invalidate: () => container.invalidate(),
          handleInput: (data: string) => {
            list.handleInput(data);
            tui.requestRender();
          },
        };
      },
      {
        overlay: true,
        overlayOptions: { anchor: "center", width: "72%", minWidth: 60, maxHeight: "85%", margin: 1 },
      },
    );

  pi.registerTool({
    name: "todo",
    label: "Todo",
    description: "Manage a branch-aware todo list. Actions: list, add, toggle, block (id + reason), unblock, clear",
    parameters: TodoParams,

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const program = Ref.get(stateRef).pipe(
        Effect.flatMap((state) =>
          parseTodoAction(params).pipe(
            Effect.flatMap((action) => transitionTodoState(state, action)),
            Effect.tap(({ state: nextState }) => Ref.set(stateRef, nextState)),
            Effect.map((transition) =>
              successfulToolResult(transition.action, transition.state, transition.message),
            ),
            Effect.catchTags({
              TodoInputError: (error) => Effect.succeed(failedToolResult(error.action, state, error.message)),
              TodoNotFoundError: (error) => Effect.succeed(failedToolResult(error.action, state, error.message)),
            }),
          ),
        ),
      );
      const result = await Effect.runPromise(program);
      if (result.details.outcome === "success") pi.appendEntry(TODO_STATE_ENTRY, result.details.state);
      renderTaskWidget(ctx, result.details.state);
      return result;
    },

    renderCall(args, theme) {
      let text = theme.fg("toolTitle", theme.bold("todo ")) + theme.fg("muted", args.action);
      if (args.text) text += ` ${theme.fg("dim", `"${args.text}"`)}`;
      if (args.id !== undefined) text += ` ${theme.fg("accent", `#${args.id}`)}`;
      if (args.reason) text += ` ${theme.fg("warning", `blocked: ${args.reason}`)}`;
      return new Text(text, 0, 0);
    },

    renderResult(result, { expanded }, theme) {
      const details = Option.getOrUndefined(decodeTodoDetails(result.details));
      if (!details) {
        const content = result.content[0];
        return new Text(content?.type === "text" ? content.text : "", 0, 0);
      }
      if (details.outcome === "error") return new Text(theme.fg("error", `Error: ${details.error}`), 0, 0);

      if (details.action === "list") {
        if (details.state.todos.length === 0) return new Text(theme.fg("dim", "No todos"), 0, 0);
        const visible = expanded ? details.state.todos : details.state.todos.slice(0, 5);
        let text = theme.fg("muted", `${details.state.todos.length} todo(s):`);
        for (const todo of visible) {
          const completed = todo.status === "completed";
          const blocked = todo.status === "blocked";
          const check = completed
            ? theme.fg("success", "✓")
            : blocked
              ? theme.fg("warning", "⊘")
              : theme.fg("dim", "○");
          const label = blocked ? `${todo.text} — blocked: ${todo.reason}` : todo.text;
          text += `\n${check} ${theme.fg("accent", `#${todo.id}`)} ${theme.fg(completed ? "dim" : "muted", label)}`;
        }
        if (!expanded && details.state.todos.length > visible.length) {
          text += `\n${theme.fg("dim", `... ${details.state.todos.length - visible.length} more`)}`;
        }
        return new Text(text, 0, 0);
      }

      const content = result.content[0];
      const message = content?.type === "text" ? content.text : "Done";
      return new Text(theme.fg("success", "✓ ") + theme.fg("muted", message), 0, 0);
    },
  });

  pi.registerCommand("todos", {
    description: "Show all todos on the current branch",
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui") {
        ctx.ui.notify("/todos requires interactive mode", "error");
        return;
      }
      const state = Effect.runSync(Ref.get(stateRef));
      await ctx.ui.custom<void>((_tui, theme, _kb, done) =>
        new TodoListComponent(state.todos, theme, () => done()),
      );
    },
  });

  pi.registerCommand("blocked", {
    description: "Triage blocked todos without auto-focusing normal prompt input",
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui") {
        ctx.ui.notify("/blocked requires interactive mode", "error");
        return;
      }
      const state = Effect.runSync(Ref.get(stateRef));
      const blocked = state.todos.filter((todo): todo is Extract<Todo, { status: "blocked" }> => todo.status === "blocked");
      if (blocked.length === 0) {
        ctx.ui.notify("No blocked todos.", "info");
        return;
      }
      const choices = blocked.map((todo) => `#${todo.id}  ${todo.text.replace(/\s+/g, " ").slice(0, 100)}`);
      const selected = await ctx.ui.select("Blocked todos · select one to triage", choices);
      if (selected === undefined) return;
      const todo = blocked[choices.indexOf(selected)];
      if (!todo) return;
      const action = await chooseBlockedAction(ctx, todo);
      if (!action) return;

      if (action === "unblock") {
        await applyUiAction({ action: "unblock", id: todo.id }, ctx);
        ctx.ui.notify(`Todo #${todo.id} unblocked.`, "info");
        return;
      }
      if (action === "resolve") {
        await applyUiAction({ action: "unblock", id: todo.id }, ctx);
        await applyUiAction({ action: "toggle", id: todo.id }, ctx);
        ctx.ui.notify(`Todo #${todo.id} resolved.`, "info");
        return;
      }
      if (action === "edit") {
        const reason = await ctx.ui.input(`New blocker reason for #${todo.id}`, todo.reason);
        if (!reason?.trim()) return;
        await applyUiAction({ action: "block", id: todo.id, reason: reason.trim() }, ctx);
        ctx.ui.notify(`Todo #${todo.id} blocker updated.`, "info");
        return;
      }
      const decision = await ctx.ui.input(`Question needed to unblock #${todo.id}`, "What decision or information is needed?");
      if (!decision?.trim()) return;
      const request: UserQuestionRequest = {
        header: "Blocked todo",
        question: `Blocked todo #${todo.id}: ${todo.text}\nCurrent blocker: ${todo.reason}\nDecision needed: ${decision.trim()}`,
      };
      pi.events.emit(QUESTION_ASK_EVENT, request);
      ctx.ui.notify(`Queued a pending question for todo #${todo.id}.`, "info");
    },
  });

  pi.registerCommand("kanban", {
    description: "Open a right-side task board overlay while keeping the session visible",
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui") {
        ctx.ui.notify("/kanban requires interactive mode", "error");
        return;
      }
      const state = Effect.runSync(Ref.get(stateRef));
      await ctx.ui.custom<void>(
        (_tui, theme, _kb, done) => new KanbanComponent(state, theme, () => done()),
        {
          overlay: true,
          overlayOptions: { anchor: "right-center", width: "40%", minWidth: 36, maxHeight: "90%", margin: 1 },
        },
      );
    },
  });
}
