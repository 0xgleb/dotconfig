import type { Theme } from "@earendil-works/pi-coding-agent"
import {
  truncateToWidth,
  visibleWidth,
  type Component,
} from "@earendil-works/pi-tui"
import { framedChromeInset } from "../shared/chrome.ts"
import type { IssueTaskCounts, IssueTaskProgress } from "./model.ts"
import type { TaskStoreError } from "./sqlite-store.ts"
import type { TaskHudFocus, TaskHudFocusError } from "./hud-focus.ts"

export type ConfirmedTaskHudFocus = Extract<
  TaskHudFocus,
  { readonly kind: "issue" }
>

export type TaskHudView =
  | { readonly kind: "none" }
  | { readonly kind: "unconfirmed" }
  | {
      readonly kind: "selection_unavailable"
      readonly code: TaskHudFocusError["code"]
    }
  | { readonly kind: "loading"; readonly focus: ConfirmedTaskHudFocus }
  | { readonly kind: "missing"; readonly focus: ConfirmedTaskHudFocus }
  | {
      readonly kind: "progress_unavailable"
      readonly focus: ConfirmedTaskHudFocus
      readonly code: TaskStoreError["code"] | "unavailable"
    }
  | {
      readonly kind: "ready"
      readonly mode: ConfirmedTaskHudFocus["mode"]
      readonly progress: IssueTaskProgress
    }

interface HudContent {
  readonly focus: ConfirmedTaskHudFocus | null
  readonly summary: string
  readonly preview: string
  readonly counts: IssueTaskCounts | null
}

const literalLine = (text: string): string =>
  text
    .replace(/\s+/gu, " ")
    .replace(
      /[\u0000-\u001f\u007f-\u009f]/gu,
      character =>
        `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
    )
    .trim()

const contentFor = (view: TaskHudView): HudContent | undefined => {
  switch (view.kind) {
    case "none":
      return undefined
    case "unconfirmed":
      return {
        focus: null,
        summary: "Task selection unconfirmed",
        preview: "Reconcile the retained pickup receipt",
        counts: null,
      }
    case "selection_unavailable":
      return {
        focus: null,
        summary: "Current issue unavailable",
        preview: `Selection ${view.code.replaceAll("_", " ")}`,
        counts: null,
      }
    case "loading":
      return {
        focus: view.focus,
        summary: "Loading progress",
        preview: "Reading persisted task state",
        counts: null,
      }
    case "missing":
      return {
        focus: view.focus,
        summary: "No local task state",
        preview: "No tasks recorded for this issue",
        counts: null,
      }
    case "progress_unavailable":
      return {
        focus: view.focus,
        summary: "Progress unavailable",
        preview: `Task store ${view.code.replaceAll("_", " ")}`,
        counts: null,
      }
    case "ready": {
      const { counts, currentTask, issue } = view.progress
      const settled = counts.done + counts.cancelled
      return {
        focus: { kind: "issue", issue, mode: view.mode },
        summary:
          counts.total === 0
            ? "0 tasks"
            : `${settled}/${counts.total} settled${counts.cancelled === 0 ? "" : ` (${counts.cancelled} cancelled)`}${counts.blocked === 0 ? "" : ` · ${counts.blocked} blocked`}`,
        preview:
          currentTask === null
            ? counts.total === 0
              ? "No tasks recorded"
              : `All tasks settled · ${counts.done} done · ${counts.cancelled} cancelled`
            : `${currentTask.status === "doing" ? "[/]" : typeof currentTask.status === "string" ? "[ ]" : "[!]"} ${literalLine(currentTask.text)}${typeof currentTask.status === "string" ? "" : ` · Blocked: ${literalLine(currentTask.status.reason)}`}`,
        counts,
      }
    }
  }
}

const issueTitle = (focus: ConfirmedTaskHudFocus, width: number): string => {
  const prefix = focus.mode === "review" ? "Review " : ""
  const suffix = `#${focus.issue.number}`
  const room = Math.max(0, width - visibleWidth(prefix + suffix))
  return `${prefix}${truncateToWidth(focus.issue.repository, room, "…")}${suffix}`
}

const headline = (content: HudContent, width: number): string => {
  const summaryWidth = visibleWidth(content.summary)
  const focusRoom = width - summaryWidth - 3
  const focus = content.focus
  const minimumFocus =
    focus === null
      ? 0
      : visibleWidth(
          `${focus.mode === "review" ? "Review " : ""}#${focus.issue.number}`,
        ) + 2
  const includesSummary = focus === null || focusRoom >= minimumFocus
  const text =
    focus === null
      ? content.summary
      : includesSummary
        ? `${issueTitle(focus, focusRoom)} · ${content.summary}`
        : issueTitle(focus, width)
  const counts = content.counts
  if (includesSummary && counts !== null && counts.total > 0) {
    const settled = BigInt(counts.done + counts.cancelled)
    const total = BigInt(counts.total)
    const percent = `${Number((settled * 100n) / total)}%`
    const cells = Math.min(
      32,
      width - visibleWidth(text) - visibleWidth(percent) - 4,
    )
    if (cells >= 8) {
      const filled = Number((settled * BigInt(cells)) / total)
      const right = `${"▰".repeat(filled)}${"▱".repeat(cells - filled)} ${percent}`
      const rule = "─".repeat(
        width - visibleWidth(text) - visibleWidth(right) - 2,
      )
      return `${text} ${rule} ${right}`
    }
  }
  return visibleWidth(text) < width ? `${text} ` : text
}

export const taskHudLines = (view: TaskHudView, width: number): string[] => {
  const content = contentFor(view)
  if (content === undefined || width <= 0) return []
  if (width < 6) return ["─".repeat(width)]
  const inset = framedChromeInset(width)
  const frameWidth = width - inset * 2
  const inner = Math.max(0, frameWidth - 6)
  const margin = " ".repeat(inset)
  const pad = (text: string, fill = " "): string => {
    const clipped = truncateToWidth(text, inner, "…")
    return clipped + fill.repeat(Math.max(0, inner - visibleWidth(clipped)))
  }
  return [
    `${margin}╭─ ${pad(headline(content, inner), "─")} ─╮${margin}`,
    `${margin}│  ${pad(content.preview)}  │${margin}`,
  ]
}

export const taskHudStatus = (view: TaskHudView): string | undefined => {
  switch (view.kind) {
    case "none":
      return undefined
    case "unconfirmed":
      return "tasks:unconfirmed"
    case "selection_unavailable":
    case "progress_unavailable":
      return "tasks:unavailable"
    case "loading":
      return "tasks:loading"
    case "missing":
      return "tasks:unrecorded"
    case "ready": {
      const counts = view.progress.counts
      return counts.total === 0
        ? "tasks:0"
        : `tasks:${counts.done + counts.cancelled}/${counts.total} settled`
    }
  }
}

const brightenForeground = (text: string): string =>
  text.replace(
    /\u001b\[38;2;(\d{1,3});(\d{1,3});(\d{1,3})m/u,
    (color: string, red: string, green: string, blue: string) => {
      const channels = [red, green, blue].map(Number)
      if (channels.some(channel => channel > 255)) return color
      const brighter = channels.map(channel =>
        Math.round(channel + (255 - channel) * 0.35),
      )
      return `\u001b[38;2;${brighter.join(";")}m`
    },
  )

const colorHeadline = (
  line: string,
  theme: Theme,
  now: number,
  idle: boolean,
): string => {
  const completed = line.match(/▰/gu)?.length ?? 0
  const frame = Math.floor(now / (idle ? 500 : 300))
  const phase = frame % (completed * 2 + 2)
  const hidden = idle && Math.floor(frame / 3) % 2 === 0
  let index = 0
  return line
    .split(/([▰▱])/u)
    .map(part => {
      if (part === "") return ""
      if (part !== "▰" && part !== "▱")
        return theme.bold(theme.fg("borderAccent", part))
      const highlighted =
        !idle &&
        part === "▰" &&
        phase % 2 === 0 &&
        (phase >= completed * 2 || index === Math.floor(phase / 2))
      index += 1
      const displayed = hidden ? "▱" : part
      const hued = theme.fg(displayed === "▰" ? "accent" : "muted", displayed)
      return highlighted ? theme.bold(brightenForeground(hued)) : hued
    })
    .join("")
}

const colorPreview = (line: string, theme: Theme): string => {
  const left = line.indexOf("│")
  const right = line.lastIndexOf("│")
  if (left < 0 || right <= left) return theme.fg("accent", line)
  return (
    theme.fg("borderAccent", line.slice(0, left + 1)) +
    theme.fg("accent", line.slice(left + 1, right)) +
    theme.fg("borderAccent", line.slice(right))
  )
}

export const createTaskHudComponent = (
  view: () => TaskHudView,
  theme: Theme,
  clock: () => number = Date.now,
  isIdle: () => boolean = () => false,
): Component => {
  let cachedView: TaskHudView | undefined
  let cachedWidth: number | undefined
  let lines: string[] = []
  return {
    render: (width: number) => {
      const snapshot = view()
      if (snapshot !== cachedView || width !== cachedWidth) {
        lines = taskHudLines(snapshot, width)
        cachedView = snapshot
        cachedWidth = width
      }
      const [head, ...preview] = lines
      if (head === undefined) return []
      return [
        colorHeadline(head, theme, clock(), isIdle()),
        ...preview.map(line => colorPreview(line, theme)),
      ]
    },
    invalidate: () => {
      cachedView = undefined
      cachedWidth = undefined
    },
  }
}
