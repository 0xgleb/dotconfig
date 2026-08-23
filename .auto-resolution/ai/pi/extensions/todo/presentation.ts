import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui"
import { framedChromeInset } from "../shared/chrome.ts"
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
 * A rendered HUD collapses to a single "idle" rule rather than a full frame
 * when there is nothing tracked. The live per-session widget goes further and
 * unmounts entirely in that case (see `shouldShowTaskHud`); the idle rule
 * here remains for any caller that renders a `TaskHud` directly.
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

/**
 * Manual operator preference for the HUD, flipped by ctrl+t. Tracked
 * independently of task counts: `shouldShowTaskHud` is the one place that
 * combines "is there anything to show" with "did the operator hide it", so
 * an empty board always wins over a stale "visible" or "hidden" preference
 * left over from before it emptied or filled.
 */
export type TaskHudVisibility = "visible" | "hidden"

export const toggleTaskHudVisibility: (
  visibility: TaskHudVisibility,
) => TaskHudVisibility = visibility =>
  visibility === "visible" ? "hidden" : "visible"

/**
 * The HUD widget mounts only when both hold: at least one tracked task
 * exists, and the operator has not hidden it with ctrl+t. An empty board is
 * never shown regardless of the toggle; toggling while empty has nothing to
 * affect until a task exists, so callers leave the preference untouched in
 * that case rather than arming it for later.
 */
export const shouldShowTaskHud: (
  summary: TodoSummary,
  visibility: TaskHudVisibility,
) => boolean = (summary, visibility) =>
  summary.total > 0 && visibility === "visible"

export interface KanbanColumns {
  readonly todo: ReadonlyArray<Todo>
  readonly inProgress: ReadonlyArray<Todo>
  readonly inReview: ReadonlyArray<Todo>
  readonly done: ReadonlyArray<Todo>
}

export const kanbanColumns: (state: TodoState) => KanbanColumns = state => ({
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

export const todoSummary: (state: TodoState) => TodoSummary = state => {
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
const GUTTER = 3
export const TASK_PROGRESS_MIN_WIDTH = 8
export const TASK_PROGRESS_MAX_WIDTH = 32

export type TaskProgressCell = "▰" | "▱"

export const taskCompletionPercent = (
  completed: number,
  total: number,
): number =>
  total <= 0
    ? 0
    : Math.round(Math.min(1, Math.max(0, completed / Math.max(1, total))) * 100)

const boundedAnimationFrame = (frame: number): number =>
  Math.abs(Math.floor(Number.isFinite(frame) ? frame : 0))

/** Idle agents hold each whole-region off/on state for three animation ticks. */
export const taskProgressIdlePulse = (frame: number): boolean =>
  Math.floor(boundedAnimationFrame(frame) / 3) % 2 === 1

/** One deterministic frame in the active completed-cell pulse cycle. */
export type TaskProgressActiveStep =
  | {
      readonly scope: "cell"
      readonly cellIndex: number
      readonly pulse: boolean
    }
  | {
      readonly scope: "all"
      readonly pulse: boolean
    }

/**
 * Each completed cell positively pulses once before advancing. The completed
 * region then pulses once as a whole before the cycle restarts.
 */
export const taskProgressActiveStep = (
  frame: number,
  completedCellCount: number,
): TaskProgressActiveStep | undefined => {
  const count = Number.isFinite(completedCellCount)
    ? Math.max(0, Math.floor(completedCellCount))
    : 0
  if (count === 0) return undefined
  const phase = boundedAnimationFrame(frame) % (count * 2 + 2)
  if (phase < count * 2) {
    return {
      scope: "cell",
      cellIndex: Math.floor(phase / 2),
      pulse: phase % 2 === 0,
    }
  }
  return { scope: "all", pulse: (phase - count * 2) % 2 === 0 }
}

/** Return the exact fixed-width glyph displayed for one progress cell. */
export const taskProgressDisplayedCell = (
  baseCell: TaskProgressCell,
  frame: number,
  _index: number,
  _completedCellCount: number,
  idle = false,
): TaskProgressCell => {
  if (baseCell === "▱") return baseCell
  return idle && !taskProgressIdlePulse(frame) ? "▱" : baseCell
}

/** Active agents positively pulse completed cells without turning them off. */
export const taskProgressCellPulse = (
  baseCell: TaskProgressCell,
  frame: number,
  index: number,
  completedCellCount: number,
  idle = false,
): boolean => {
  if (idle || baseCell === "▱") return false
  const step = taskProgressActiveStep(frame, completedCellCount)
  if (!step?.pulse) return false
  return step.scope === "all" || Math.floor(index) === step.cellIndex
}

export const taskProgressBar = (
  completed: number,
  total: number,
  requestedWidth = TASK_PROGRESS_MIN_WIDTH,
): string => {
  const finiteRequestedWidth = Number.isFinite(requestedWidth)
    ? Math.floor(requestedWidth)
    : TASK_PROGRESS_MIN_WIDTH
  const width = Math.min(
    TASK_PROGRESS_MAX_WIDTH,
    Math.max(TASK_PROGRESS_MIN_WIDTH, finiteRequestedWidth),
  )
  const boundedTotal = Math.max(0, total)
  const ratio =
    boundedTotal === 0 ? 0 : Math.min(1, Math.max(0, completed / boundedTotal))
  const filled = Math.round(ratio * width)
  const empty = width - filled

  return `${"▰".repeat(filled)}${"▱".repeat(empty)}`
}

export const taskProgressWidthForPane = (
  paneWidth: number | undefined,
  leftLabel: string,
  rightSuffix: string,
): number => {
  if (paneWidth === undefined || !Number.isFinite(paneWidth))
    return TASK_PROGRESS_MIN_WIDTH
  const boundedPaneWidth = Math.max(0, Math.floor(paneWidth))
  const inset = framedChromeInset(boundedPaneWidth)
  const frameWidth = Math.max(GUTTER * 2, boundedPaneWidth - inset * 2)
  const inner = Math.max(0, frameWidth - GUTTER * 2)
  // rule() spends three cells on the two label gaps and their separating rule.
  const available =
    inner - 3 - visibleWidth(leftLabel) - visibleWidth(rightSuffix)
  return Math.min(
    TASK_PROGRESS_MAX_WIDTH,
    Math.max(TASK_PROGRESS_MIN_WIDTH, available),
  )
}

export const taskHud: (
  state: TodoState,
  now?: number,
  paneWidth?: number,
) => TaskHud = (state, now = Date.now(), paneWidth) => {
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
  const headlineLeft = `TASKS  ·  ${metrics.join("  ·  ")}`
  const completionPercent = taskCompletionPercent(
    summary.completed,
    summary.total,
  )
  const headlineRightSuffix = `  ${completionPercent}%  ·  /kanban`
  const progressWidth = taskProgressWidthForPane(
    paneWidth,
    headlineLeft,
    headlineRightSuffix,
  )
  return {
    kind: "tracking",
    headline: {
      left: headlineLeft,
      right: `${taskProgressBar(summary.completed, summary.total, progressWidth)}${headlineRightSuffix}`,
    },
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

export const taskHudInset = framedChromeInset

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
    ]
  }

  return [
    framed(`╭─ ${rule(inner, hud.headline)} ─╮`),
    ...hud.rows.map(row =>
      framed(`│  ${pad(`${todoStatusMark(row.status)} ${row.text}`)}  │`),
    ),
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
  [left, right].filter(part => part.length > 0).join("  ·  ")

/** Flattened HUD text, without the frame — the bounded footprint the editor reserves. */
export const taskHudLines: (state: TodoState, now?: number) => string[] = (
  state,
  now = Date.now(),
) => {
  const hud = taskHud(state, now)
  if (hud.kind === "idle") return [ruleText(hud.headline), "No active tasks"]
  return [
    ruleText(hud.headline),
    ...hud.rows.map(row => `${todoStatusMark(row.status)} ${row.text}`),
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

const compactTaskText: (text: string) => string = text =>
  text.length <= 96 ? text : `${text.slice(0, 93)}...`
