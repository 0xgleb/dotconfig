import type { Todo, TodoState } from "./state.ts";

export interface TodoSummary {
  readonly total: number;
  readonly completed: number;
  readonly pending: number;
  readonly blocked: number;
}

export interface KanbanColumns {
  readonly now: ReadonlyArray<Todo>;
  readonly next: ReadonlyArray<Todo>;
  readonly done: ReadonlyArray<Todo>;
}

export const kanbanColumns: (state: TodoState) => KanbanColumns = (state) => {
  const pending = state.todos.filter(({ status }) => status === "pending");
  return {
    now: pending.slice(0, 1),
    next: [...pending.slice(1), ...state.todos.filter(({ status }) => status === "blocked")],
    done: state.todos.filter(({ status }) => status === "completed"),
  };
};

export const todoSummary: (state: TodoState) => TodoSummary = (state) => {
  const completed = state.todos.filter(({ status }) => status === "completed").length;
  const pending = state.todos.filter(({ status }) => status === "pending").length;
  const blocked = state.todos.filter(({ status }) => status === "blocked").length;
  return { total: state.todos.length, completed, pending, blocked };
};

export const topPendingTodos: (state: TodoState, limit: number) => ReadonlyArray<Todo> = (state, limit) => {
  return state.todos.filter(({ status }) => status === "pending").slice(0, Math.max(0, limit));
};

export const taskWidgetLines: (state: TodoState, limit?: number) => string[] = (state, limit = 5) => {
  if (state.todos.length === 0) return [];

  const summary = todoSummary(state);
  const top = topPendingTodos(state, limit);
  const blocked = state.todos.filter((todo): todo is Extract<Todo, { status: "blocked" }> => todo.status === "blocked");
  const blockedLabel = summary.blocked > 0 ? ` · ${summary.blocked} blocked` : "";
  const lines = [
    `Tasks: ${summary.completed}/${summary.total} done · ${summary.pending} active${blockedLabel} · /kanban`,
  ];

  if (top.length === 0 && blocked.length === 0) {
    lines.push("✓ all tracked tasks complete");
    return lines;
  }

  for (const todo of top) lines.push(`○ #${todo.id} ${compactTaskText(todo.text)}`);
  if (summary.pending > top.length) lines.push(`… ${summary.pending - top.length} more active task(s)`);
  for (const todo of blocked.slice(0, Math.max(1, limit - top.length))) {
    lines.push(`⊘ #${todo.id} ${compactTaskText(todo.text)} — blocked: ${compactTaskText(todo.reason)}`);
  }
  if (blocked.length > Math.max(1, limit - top.length)) {
    lines.push(`… ${blocked.length - Math.max(1, limit - top.length)} more blocked task(s)`);
  }
  return lines;
};

const compactTaskText: (text: string) => string = (text) =>
  text.length <= 96 ? text : `${text.slice(0, 93)}...`;
