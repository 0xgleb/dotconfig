import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { todoStatusMark, type Todo, type TodoState } from "./state.ts";

export interface TodoSummary {
  readonly total: number;
  readonly completed: number;
  readonly pending: number;
  readonly inProgress: number;
  readonly blocked: number;
  readonly deferred: number;
  readonly cancelled: number;
}

export interface KanbanColumns {
  readonly now: ReadonlyArray<Todo>;
  readonly next: ReadonlyArray<Todo>;
  readonly done: ReadonlyArray<Todo>;
}

export const kanbanColumns: (state: TodoState) => KanbanColumns = (state) => {
  const inProgress = state.todos.filter(({ status }) => status === "in_progress");
  const pending = state.todos.filter(({ status }) => status === "pending");
  const now = inProgress.length > 0 ? inProgress : pending.slice(0, 1);
  const nowIds = new Set(now.map(({ id }) => id));
  return {
    now,
    next: state.todos.filter(
      ({ id, status }) => !nowIds.has(id) && (status === "pending" || status === "blocked" || status === "deferred"),
    ),
    done: state.todos.filter(({ status }) => status === "completed" || status === "cancelled"),
  };
};

export const todoSummary: (state: TodoState) => TodoSummary = (state) => {
  const completed = state.todos.filter(({ status }) => status === "completed").length;
  const inProgress = state.todos.filter(({ status }) => status === "in_progress").length;
  const pending = state.todos.filter(({ status }) => status === "pending" || status === "in_progress").length;
  const blocked = state.todos.filter(({ status }) => status === "blocked").length;
  const deferred = state.todos.filter(({ status }) => status === "deferred").length;
  const cancelled = state.todos.filter(({ status }) => status === "cancelled").length;
  return { total: state.todos.length, completed, pending, inProgress, blocked, deferred, cancelled };
};

export const topPendingTodos: (state: TodoState, limit: number) => ReadonlyArray<Todo> = (state, limit) => {
  const active = state.todos.filter(({ status }) => status === "in_progress");
  const queued = state.todos.filter(({ status }) => status === "pending");
  return [...active, ...queued].slice(0, Math.max(0, limit));
};

const HUD_SETTLE_DELAY_MS = 10_000;

export const taskHudLines: (state: TodoState, now?: number) => string[] = (state, now = Date.now()) => {
  const summary = todoSummary(state);
  if (summary.total === 0) return [];
  const recent = state.todos
    .filter(
      ({ status, statusChangedAt }) =>
        (status === "completed" || status === "cancelled") &&
        statusChangedAt !== undefined &&
        now - statusChangedAt < HUD_SETTLE_DELAY_MS,
    )
    .slice(-2)
    .reverse();
  const ordered = [
    ...recent,
    ...state.todos.filter(({ status }) => status === "in_progress"),
    ...state.todos.filter(({ status }) => status === "pending"),
    ...state.todos.filter(({ status }) => status === "blocked"),
    ...state.todos.filter(({ status }) => status === "deferred"),
  ];
  const visible = ordered.filter((todo, index) => ordered.findIndex(({ id }) => id === todo.id) === index).slice(0, 2);
  const metrics = [
    `${summary.pending} active`,
    ...(summary.blocked > 0 ? [`${summary.blocked} blocked`] : []),
    ...(summary.deferred > 0 ? [`${summary.deferred} deferred`] : []),
  ];
  const lines = [
    `TASKS  ·  ${metrics.join("  ·  ")}  ·  /kanban`,
    ...visible.map(
      (todo, index) =>
        `${todoStatusMark(todo.status)} ${String(index + 1).padStart(2, "0")}  #${todo.id}  ${compactTaskText(todo.text)}`,
    ),
  ];
  const hidden = Math.max(0, ordered.length - visible.length);
  lines.push(
    hidden > 0
      ? `+${hidden} hidden  ·  ${summary.completed}/${summary.total} complete`
      : `${summary.completed}/${summary.total} complete`,
  );
  return lines.slice(0, 4);
};

export const frameTaskHudLines: (lines: ReadonlyArray<string>, width: number) => string[] = (lines, width) =>
  lines.map((line, index) => {
    const isHeader = index === 0;
    const isFooter = index === lines.length - 1;
    const prefix = isHeader ? "╭─ " : isFooter ? "╰─ " : "│ ";
    const suffix = isHeader ? "╮" : isFooter ? "╯" : "│";
    const available = Math.max(0, width - visibleWidth(prefix) - visibleWidth(suffix));
    const content = truncateToWidth(line, available, "");
    const fill = (isHeader || isFooter ? "─" : " ").repeat(Math.max(0, available - visibleWidth(content)));
    return `${prefix}${content}${fill}${suffix}`;
  });

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
    lines.push("[x] all tracked tasks complete");
    return lines;
  }

  for (const todo of top) lines.push(`${todoStatusMark(todo.status)} #${todo.id} ${compactTaskText(todo.text)}`);
  if (summary.pending > top.length) lines.push(`… ${summary.pending - top.length} more active task(s)`);
  for (const todo of blocked.slice(0, Math.max(1, limit - top.length))) {
    lines.push(`[!] #${todo.id} ${compactTaskText(todo.text)} — blocked: ${compactTaskText(todo.reason)}`);
  }
  if (blocked.length > Math.max(1, limit - top.length)) {
    lines.push(`… ${blocked.length - Math.max(1, limit - top.length)} more blocked task(s)`);
  }
  return lines;
};

const compactTaskText: (text: string) => string = (text) =>
  text.length <= 96 ? text : `${text.slice(0, 93)}...`;
