/**
 * Adapted from diegopetrucci/pi-extensions at
 * 966ac95f8d717be6f763c62c88f4beb92b6554d3. The branch-aware session storage
 * and defensive immutable snapshots are preserved; state and failures are
 * modeled with Effect.
 */

import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, Text, truncateToWidth } from "@earendil-works/pi-tui";
import { Effect, Option, Ref } from "effect";
import { Type } from "typebox";
import {
  decodeTodoDetails,
  emptyTodoState,
  parseTodoAction,
  transitionTodoState,
  type Todo,
  type TodoAction,
  type TodoDetails,
  type TodoState,
} from "./state.ts";

const TodoParams = Type.Object({
  action: StringEnum(["list", "add", "toggle", "clear"] as const),
  text: Type.Optional(Type.String({ description: "Todo text (for add)" })),
  id: Type.Optional(Type.Number({ description: "Todo ID (for toggle)" })),
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
      lines.push(truncateToWidth(`  ${this.theme.fg("muted", `${completed}/${this.todos.length} completed`)}`, width), "");
      for (const todo of this.todos) {
        const isCompleted = todo.status === "completed";
        const check = isCompleted ? this.theme.fg("success", "✓") : this.theme.fg("dim", "○");
        const id = this.theme.fg("accent", `#${todo.id}`);
        const text = this.theme.fg(isCompleted ? "dim" : "text", todo.text);
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

function successfulToolResult(action: TodoAction["action"], state: TodoState, message: string) {
  const details: TodoDetails = { outcome: "success", action, state };
  return { content: [{ type: "text" as const, text: message }], details };
}

function failedToolResult(action: TodoAction["action"], state: TodoState, error: string) {
  const details: TodoDetails = { outcome: "error", action, state, error };
  return { content: [{ type: "text" as const, text: `Error: ${error}` }], details };
}

function restoredState(ctx: ExtensionContext): TodoState {
  const states = ctx.sessionManager.getBranch().flatMap((entry) => {
    if (entry.type !== "message" || entry.message.role !== "toolResult" || entry.message.toolName !== "todo") return [];
    return Option.toArray(decodeTodoDetails(entry.message.details)).map(({ state }) => state);
  });
  return states.at(-1) ?? emptyTodoState;
}

export default function todoExtension(pi: ExtensionAPI): void {
  const stateRef = Effect.runSync(Ref.make<TodoState>(emptyTodoState));

  const reconstructState = (ctx: ExtensionContext) => Ref.set(stateRef, restoredState(ctx));
  pi.on("session_start", async (_event, ctx) => Effect.runPromise(reconstructState(ctx)));
  pi.on("session_tree", async (_event, ctx) => Effect.runPromise(reconstructState(ctx)));

  pi.registerTool({
    name: "todo",
    label: "Todo",
    description: "Manage a branch-aware todo list. Actions: list, add (text), toggle (id), clear",
    parameters: TodoParams,

    async execute(_toolCallId, params) {
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
      return Effect.runPromise(program);
    },

    renderCall(args, theme) {
      let text = theme.fg("toolTitle", theme.bold("todo ")) + theme.fg("muted", args.action);
      if (args.text) text += ` ${theme.fg("dim", `"${args.text}"`)}`;
      if (args.id !== undefined) text += ` ${theme.fg("accent", `#${args.id}`)}`;
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
          const check = completed ? theme.fg("success", "✓") : theme.fg("dim", "○");
          text += `\n${check} ${theme.fg("accent", `#${todo.id}`)} ${theme.fg(completed ? "dim" : "muted", todo.text)}`;
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
}
