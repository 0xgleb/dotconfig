import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { todoStatusMark, type Todo, type TodoState, type TodoStatus } from "./state.ts";

/**
 * A rule is a framed edge of the HUD carrying up to two labels. The renderer
 * pins `left` after the opening corner and `right` before the closing one, so
 * every session draws the same columns regardless of how long the labels are.
 * Either half may be empty; the rule then spans the gap with its border run.
 */
export interface TaskHudRule {
  readonly left: string;
  readonly right: string;
}

export interface TaskHudRow {
  readonly status: TodoStatus;
  readonly text: string;
}

export interface TaskHud {
  readonly headline: TaskHudRule;
  readonly rows: ReadonlyArray<TaskHudRow>;
  readonly footer: TaskHudRule;
}

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

const HUD_ROW_LIMIT = 2;

export const taskHud: (state: TodoState, now?: number) => TaskHud | undefined = (state, now = Date.now()) => {
  const summary = todoSummary(state);
  if (summary.total === 0) return undefined;
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
  const visible = ordered
    .filter((todo, index) => ordered.findIndex(({ id }) => id === todo.id) === index)
    .slice(0, HUD_ROW_LIMIT);
  const metrics = [
    `${summary.pending} active`,
    ...(summary.blocked > 0 ? [`${summary.blocked} blocked`] : []),
    ...(summary.deferred > 0 ? [`${summary.deferred} deferred`] : []),
  ];
  const hidden = Math.max(0, ordered.length - visible.length);
  return {
    headline: { left: `TASKS  ·  ${metrics.join("  ·  ")}`, right: "/kanban" },
    rows: visible.map((todo, index) => ({
      status: todo.status,
      text: `${String(index + 1).padStart(2, "0")}  #${todo.id}  ${compactTaskText(todo.text)}`,
    })),
    footer: {
      left: hidden > 0 ? `+${hidden} hidden` : "",
      right: `${summary.completed}/${summary.total} complete`,
    },
  };
};

/**
 * Every framed line spends the same number of columns on its border, so task
 * text starts in one column across the headline, the rows, and the footer.
 */
const GUTTER = 3;

/**
 * Renders exactly `inner` columns. Each label keeps a blank column between
 * itself and the border run, and a label is dropped entirely rather than
 * squeezed against the rule when the width cannot hold it.
 */
const rule = (inner: number, { left, right }: TaskHudRule): string => {
  if (inner <= 0) return "";
  const border = (count: number): string => "─".repeat(Math.max(0, count));

  const tail = inner >= 6 ? truncateToWidth(right, Math.floor((inner - 5) / 2), "…") : "";
  const tailWidth = visibleWidth(tail);
  const head = truncateToWidth(left, Math.max(0, inner - tailWidth - (tailWidth > 0 ? 4 : 2)), "…");
  const headWidth = visibleWidth(head);

  if (headWidth === 0 && tailWidth === 0) return border(inner);
  if (headWidth === 0) return `${border(inner - tailWidth - 1)} ${tail}`;
  if (tailWidth === 0) return `${head} ${border(inner - headWidth - 1)}`;
  return `${head} ${border(inner - headWidth - tailWidth - 2)} ${tail}`;
};

export const frameTaskHud: (hud: TaskHud, width: number) => string[] = (hud, width) => {
  const inner = Math.max(0, width - GUTTER * 2);
  const pad = (text: string): string => {
    const content = truncateToWidth(text, inner, "…");
    return `${content}${" ".repeat(Math.max(0, inner - visibleWidth(content)))}`;
  };

  return [
    `╭─ ${rule(inner, hud.headline)} ─╮`,
    ...hud.rows.map((row) => `│  ${pad(`${todoStatusMark(row.status)} ${row.text}`)}  │`),
    `╰─ ${rule(inner, hud.footer)} ─╯`,
  ];
};

/** Flattened HUD text, without the frame — the bounded footprint the editor reserves. */
export const taskHudLines: (state: TodoState, now?: number) => string[] = (state, now = Date.now()) => {
  const hud = taskHud(state, now);
  if (hud === undefined) return [];
  const label = ({ left, right }: TaskHudRule): string => [left, right].filter((part) => part.length > 0).join("  ·  ");
  return [
    label(hud.headline),
    ...hud.rows.map((row) => `${todoStatusMark(row.status)} ${row.text}`),
    label(hud.footer),
  ];
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
