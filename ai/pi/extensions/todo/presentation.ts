import type { Todo, TodoState } from "./state.ts";

export interface TodoSummary {
  readonly total: number;
  readonly completed: number;
  readonly pending: number;
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
    next: pending.slice(1),
    done: state.todos.filter(({ status }) => status === "completed"),
  };
};

export const todoSummary: (state: TodoState) => TodoSummary = (state) => {
  const completed = state.todos.filter(({ status }) => status === "completed").length;
  return { total: state.todos.length, completed, pending: state.todos.length - completed };
};

export const topPendingTodos: (state: TodoState, limit: number) => ReadonlyArray<Todo> = (state, limit) => {
  return state.todos.filter(({ status }) => status === "pending").slice(0, Math.max(0, limit));
};

export const taskWidgetLines: (state: TodoState, limit?: number) => string[] = (state, limit = 5) => {
  if (state.todos.length === 0) return [];

  const summary = todoSummary(state);
  const top = topPendingTodos(state, limit);
  const lines = [`Tasks: ${summary.completed}/${summary.total} done · ${summary.pending} active · /kanban`];

  if (top.length === 0) {
    lines.push("✓ all tracked tasks complete");
    return lines;
  }

  for (const todo of top) {
    lines.push(`○ #${todo.id} ${compactTaskText(todo.text)}`);
  }

  if (summary.pending > top.length) lines.push(`… ${summary.pending - top.length} more active task(s)`);
  return lines;
};

const compactTaskText: (text: string) => string = (text) =>
  text.length <= 96 ? text : `${text.slice(0, 93)}...`;
