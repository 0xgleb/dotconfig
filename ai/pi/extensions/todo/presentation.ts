import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui"
import {
  todoStatusMark,
  type Todo,
  type TodoState,
  type TodoStatus,
} from "./state.ts"

/**
 * A rule is a framed edge of the HUD carrying up to two labels. The renderer
 * pins `left` after the opening corner and `right` before the closing one, so
 * every session draws the same columns regardless of how long the labels are.
 * Either half may be empty; the rule then spans the gap with its border run.
 */
export interface TaskHudRule {
  readonly left: string
  readonly right: string
}

export interface TaskHudRow {
  readonly status: TodoStatus
  readonly text: string
}

/**
 * The HUD is always present so every session shows the same fixture; a session
 * with nothing tracked collapses to a single rule rather than disappearing and
 * leaving neighbouring panes looking like different programs.
 */
export type TaskHud =
  | { readonly kind: "idle"; readonly headline: TaskHudRule }
  | {
      readonly kind: "tracking"
      readonly headline: TaskHudRule
      readonly rows: ReadonlyArray<TaskHudRow>
      readonly footer: TaskHudRule
    }

export interface TodoSummary {
  readonly total: number
  readonly completed: number
  readonly pending: number
  readonly inProgress: number
  readonly inReview: number
  readonly blocked: number
  readonly deferred: number
  readonly cancelled: number
}

export interface KanbanColumns {
  readonly todo: ReadonlyArray<Todo>
  readonly inProgress: ReadonlyArray<Todo>
  readonly inReview: ReadonlyArray<Todo>
  readonly done: ReadonlyArray<Todo>
}

export const kanbanColumns: (state: TodoState) => KanbanColumns = (state) => ({
  todo: state.todos.filter(
    ({ status }) =>
      status === "pending" || status === "blocked" || status === "deferred",
  ),
  inProgress: state.todos.filter(({ status }) => status === "in_progress"),
  inReview: state.todos.filter(({ status }) => status === "in_review"),
  done: state.todos.filter(
    ({ status }) => status === "completed" || status === "cancelled",
  ),
})

export const todoSummary: (state: TodoState) => TodoSummary = (state) => {
  const completed = state.todos.filter(
    ({ status }) => status === "completed",
  ).length
  const inProgress = state.todos.filter(
    ({ status }) => status === "in_progress",
  ).length
  const inReview = state.todos.filter(
    ({ status }) => status === "in_review",
  ).length
  const pending = state.todos.filter(
    ({ status }) =>
      status === "pending" ||
      status === "in_progress" ||
      status === "in_review",
  ).length
  const blocked = state.todos.filter(
    ({ status }) => status === "blocked",
  ).length
  const deferred = state.todos.filter(
    ({ status }) => status === "deferred",
  ).length
  const cancelled = state.todos.filter(
    ({ status }) => status === "cancelled",
  ).length
  return {
    total: state.todos.length,
    completed,
    pending,
    inProgress,
    inReview,
    blocked,
    deferred,
    cancelled,
  }
}

export const topPendingTodos: (
  state: TodoState,
  limit: number,
) => ReadonlyArray<Todo> = (state, limit) => {
  const active = state.todos.filter(({ status }) => status === "in_progress")
  const review = state.todos.filter(({ status }) => status === "in_review")
  const queued = state.todos.filter(({ status }) => status === "pending")
  return [...active, ...review, ...queued].slice(0, Math.max(0, limit))
}

const HUD_SETTLE_DELAY_MS = 10_000

const HUD_ROW_LIMIT = 1

export const taskHud: (state: TodoState, now?: number) => TaskHud = (
  state,
  now = Date.now(),
) => {
  const summary = todoSummary(state)
  if (summary.total === 0) {
    return {
      kind: "idle",
      headline: { left: "TASKS  ·  nothing tracked", right: "/kanban" },
    }
  }
  const recent = state.todos
    .filter(
      ({ status, statusChangedAt }) =>
        (status === "completed" || status === "cancelled") &&
        statusChangedAt !== undefined &&
        now - statusChangedAt < HUD_SETTLE_DELAY_MS,
    )
    .slice(-2)
    .reverse()
  const ordered = [
    ...recent,
    ...state.todos.filter(({ status }) => status === "in_progress"),
    ...state.todos.filter(({ status }) => status === "in_review"),
    ...state.todos.filter(({ status }) => status === "pending"),
    ...state.todos.filter(({ status }) => status === "blocked"),
    ...state.todos.filter(({ status }) => status === "deferred"),
  ]
  const visible = ordered
    .filter(
      (todo, index) => ordered.findIndex(({ id }) => id === todo.id) === index,
    )
    .slice(0, HUD_ROW_LIMIT)
  const metrics = [
    `${summary.pending} active`,
    ...(summary.blocked > 0 ? [`${summary.blocked} blocked`] : []),
    ...(summary.deferred > 0 ? [`${summary.deferred} deferred`] : []),
  ]
  const hidden = Math.max(0, ordered.length - visible.length)
  return {
    kind: "tracking",
    headline: { left: `TASKS  ·  ${metrics.join("  ·  ")}`, right: "/kanban" },
    rows: visible.map((todo, index) => ({
      status: todo.status,
      text: `${String(index + 1).padStart(2, "0")}  #${todo.id}  ${compactTaskText(todo.text)}`,
    })),
    footer: {
      left: hidden > 0 ? `+${hidden} hidden` : "",
      right: `${summary.completed}/${summary.total} complete`,
    },
  }
}

/**
 * Every framed line spends the same number of columns on its border, so task
 * text starts in one column across the headline, the rows, and the footer.
 */
const GUTTER = 3

/**
 * Renders exactly `inner` columns. Each label keeps a blank column between
 * itself and the border run, and a label is dropped entirely rather than
 * squeezed against the rule when the width cannot hold it.
 */
/**
 * Splits the available columns between two labels: whole when they both fit,
 * otherwise shrinking the longer one first so a short label is never elided to
 * make room for a long one it already fits beside.
 */
const share = (
  head: number,
  tail: number,
  budget: number,
): readonly [number, number] => {
  if (budget <= 0) return [0, 0]
  if (head + tail <= budget) return [head, tail]
  const half = Math.floor(budget / 2)
  if (head <= half) return [head, budget - head]
  if (tail <= half) return [budget - tail, tail]
  return [half, budget - half]
}

const rule = (inner: number, { left, right }: TaskHudRule): string => {
  if (inner <= 0) return ""
  const border = (count: number): string => "─".repeat(Math.max(0, count))
  const anchored = (label: string, toLeft: boolean): string => {
    const only = truncateToWidth(label, Math.max(0, inner - 2), "…")
    const width = visibleWidth(only)
    if (width === 0) return border(inner)
    return toLeft
      ? `${only} ${border(inner - width - 1)}`
      : `${border(inner - width - 1)} ${only}`
  }

  if (left.length === 0 && right.length === 0) return border(inner)
  if (right.length === 0) return anchored(left, true)
  if (left.length === 0) return anchored(right, false)

  // One blank column beside each label, and at least one border cell between.
  const [headRoom, tailRoom] = share(
    visibleWidth(left),
    visibleWidth(right),
    inner - 3,
  )
  const head = truncateToWidth(left, headRoom, "…")
  const tail = truncateToWidth(right, tailRoom, "…")
  const headWidth = visibleWidth(head)
  const tailWidth = visibleWidth(tail)

  if (headWidth === 0)
    return tailWidth === 0 ? border(inner) : anchored(right, false)
  if (tailWidth === 0) return anchored(left, true)
  return `${head} ${border(inner - headWidth - tailWidth - 2)} ${tail}`
}

export const taskHudInset = (width: number): number => {
  const desired = Math.min(6, Math.max(3, Math.floor(width * 0.03)))
  const available = Math.max(0, Math.floor((width - GUTTER * 2) / 2))

  return Math.min(desired, available)
}

export const frameTaskHud: (hud: TaskHud, width: number) => string[] = (
  hud,
  width,
) => {
  const inset = taskHudInset(width)
  const frameWidth = Math.max(GUTTER * 2, width - inset * 2)
  const inner = Math.max(0, frameWidth - GUTTER * 2)
  const leftMargin = " ".repeat(inset)
  const rightMargin = " ".repeat(Math.max(0, width - inset - frameWidth))
  const framed = (line: string): string => `${leftMargin}${line}${rightMargin}`
  const pad = (text: string): string => {
    const content = truncateToWidth(text, inner, "…")
    return `${content}${" ".repeat(Math.max(0, inner - visibleWidth(content)))}`
  }

  if (hud.kind === "idle") {
    return [
      framed(`╭─ ${rule(inner, hud.headline)} ─╮`),
      framed(`│  ${pad("No active tasks")}  │`),
      framed(`╰─ ${rule(inner, { left: "", right: "" })} ─╯`),
    ]
  }

  return [
    framed(`╭─ ${rule(inner, hud.headline)} ─╮`),
    ...hud.rows.map((row) =>
      framed(`│  ${pad(`${todoStatusMark(row.status)} ${row.text}`)}  │`),
    ),
    framed(`╰─ ${rule(inner, hud.footer)} ─╯`),
  ]
}

/**
 * A section rule for full-width overlays, drawn on the same columns as the HUD
 * frame so the compact and expanded views read as one interface.
 */
export const overlayRule: (labels: TaskHudRule, width: number) => string = (
  labels,
  width,
) => `╶─ ${rule(Math.max(0, width - GUTTER * 2), labels)} ─╴`

/** The column every framed line starts its content in. */
export const CONTENT_GUTTER = " ".repeat(GUTTER)

const ruleText = ({ left, right }: TaskHudRule): string =>
  [left, right].filter((part) => part.length > 0).join("  ·  ")

/** Flattened HUD text, without the frame — the bounded footprint the editor reserves. */
export const taskHudLines: (state: TodoState, now?: number) => string[] = (
  state,
  now = Date.now(),
) => {
  const hud = taskHud(state, now)
  if (hud.kind === "idle")
    return [ruleText(hud.headline), "No active tasks", ""]
  return [
    ruleText(hud.headline),
    ...hud.rows.map((row) => `${todoStatusMark(row.status)} ${row.text}`),
    ruleText(hud.footer),
  ]
}

export const taskWidgetLines: (state: TodoState, limit?: number) => string[] = (
  state,
  limit = 5,
) => {
  if (state.todos.length === 0) return []

  const summary = todoSummary(state)
  const top = topPendingTodos(state, limit)
  const blocked = state.todos.filter(
    (todo): todo is Extract<Todo, { status: "blocked" }> =>
      todo.status === "blocked",
  )
  const blockedLabel =
    summary.blocked > 0 ? ` · ${summary.blocked} blocked` : ""
  const lines = [
    `Tasks: ${summary.completed}/${summary.total} done · ${summary.pending} active${blockedLabel} · /kanban`,
  ]

  if (top.length === 0 && blocked.length === 0) {
    lines.push("[x] all tracked tasks complete")
    return lines
  }

  for (const todo of top)
    lines.push(
      `${todoStatusMark(todo.status)} #${todo.id} ${compactTaskText(todo.text)}`,
    )
  if (summary.pending > top.length)
    lines.push(`… ${summary.pending - top.length} more active task(s)`)
  for (const todo of blocked.slice(0, Math.max(1, limit - top.length))) {
    lines.push(
      `[!] #${todo.id} ${compactTaskText(todo.text)} — blocked: ${compactTaskText(todo.reason)}`,
    )
  }
  if (blocked.length > Math.max(1, limit - top.length)) {
    lines.push(
      `… ${blocked.length - Math.max(1, limit - top.length)} more blocked task(s)`,
    )
  }
  return lines
}

const compactTaskText: (text: string) => string = (text) =>
  text.length <= 96 ? text : `${text.slice(0, 93)}...`
