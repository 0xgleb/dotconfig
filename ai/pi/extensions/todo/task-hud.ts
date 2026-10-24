import type { Theme } from "@earendil-works/pi-coding-agent"
import { Data, Effect } from "effect"

import {
  frameTaskHud,
  taskHud,
  taskProgressCellPulse,
  taskProgressDisplayedCell,
  type TaskProgressCell,
} from "./presentation.ts"
import type { TodoState } from "./state.ts"

const TASK_PROGRESS_BAR = /([▰▱]{8,32})/u
const TASK_PROGRESS_CELL = /^[▰▱]$/u

export const HUD_ANIMATION_INTERVAL_MS = 300
export const HUD_IDLE_ANIMATION_INTERVAL_MS = 500

export interface TaskHudAnimationOptions {
  readonly idle?: boolean
  readonly intervalMs?: number
}

const brightenTruecolorForeground = (text: string): string | undefined => {
  const color = /\x1b\[38;2;(\d+);(\d+);(\d+)m/u
  const match = color.exec(text)
  if (!match) return undefined
  const channels = match.slice(1).map(Number)
  if (channels.some(channel => channel < 0 || channel > 255)) return undefined
  const [red = 0, green = 0, blue = 0] = channels.map(channel =>
    Math.round(channel + (255 - channel) * 0.35),
  )
  return text.replace(color, `\x1b[38;2;${red};${green};${blue}m`)
}

export class TaskHudFrameError extends Data.TaggedError("TaskHudFrameError")<{
  readonly message: string
}> {}

type TaskHudFrameResult =
  | { readonly ok: true; readonly value: number }
  | { readonly ok: false; readonly error: TaskHudFrameError }

const taskHudFrameResult = (
  now: number,
  intervalMs: number,
): TaskHudFrameResult => {
  if (!Number.isSafeInteger(now) || now < 0)
    return {
      ok: false,
      error: new TaskHudFrameError({
        message: "task HUD timestamp must be a non-negative integer",
      }),
    }
  return !Number.isSafeInteger(intervalMs) || intervalMs < 1
    ? {
        ok: false,
        error: new TaskHudFrameError({
          message: "task HUD interval must be a positive integer",
        }),
      }
    : { ok: true, value: Math.floor(now / intervalMs) }
}

export const synchronizedTaskHudFrame = (
  now: number,
  intervalMs = HUD_ANIMATION_INTERVAL_MS,
): Effect.Effect<number, TaskHudFrameError> => {
  const result = taskHudFrameResult(now, intervalMs)
  return result.ok ? Effect.succeed(result.value) : Effect.fail(result.error)
}

export class TaskHudComponent {
  private readonly state: TodoState
  private readonly theme: Theme
  private readonly animationIntervalMs: number
  private readonly idle: boolean

  constructor(
    state: TodoState,
    theme: Theme,
    _requestRender: () => void = () => {},
    options: TaskHudAnimationOptions = {},
  ) {
    const animationIntervalMs =
      options.intervalMs ??
      (options.idle
        ? HUD_IDLE_ANIMATION_INTERVAL_MS
        : HUD_ANIMATION_INTERVAL_MS)
    this.state = state
    this.theme = theme
    this.animationIntervalMs = animationIntervalMs
    this.idle = options.idle ?? false
  }

  private colorTaskHeadline(line: string, animationFrame: number): string {
    return line
      .split(TASK_PROGRESS_BAR)
      .map(part =>
        TASK_PROGRESS_BAR.test(part)
          ? [...part]
              .map((cell, index, cells) => {
                if (!TASK_PROGRESS_CELL.test(cell)) return cell
                const progressCell = cell as TaskProgressCell
                const completedCellCount =
                  cells.findLastIndex(candidate => candidate !== "▱") + 1
                const displayedCell = taskProgressDisplayedCell(
                  progressCell,
                  animationFrame,
                  index,
                  completedCellCount,
                  this.idle,
                )
                const pulseOn = taskProgressCellPulse(
                  progressCell,
                  animationFrame,
                  index,
                  completedCellCount,
                  this.idle,
                )
                const hued = this.theme.fg(
                  displayedCell === "▱" ? "muted" : "accent",
                  displayedCell,
                )
                if (!pulseOn) return hued
                return this.theme.bold(
                  brightenTruecolorForeground(hued) ?? hued,
                )
              })
              .join("")
          : this.theme.bold(this.theme.fg("borderAccent", part)),
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
    const animationFrameResult = taskHudFrameResult(
      Date.now(),
      this.animationIntervalMs,
    )
    if (!animationFrameResult.ok)
      return [this.theme.fg("warning", animationFrameResult.error.message)]
    const animationFrame = animationFrameResult.value
    const hud = taskHud(this.state, Date.now(), width)
    const framed = frameTaskHud(hud, width)
    if (hud.kind === "idle") {
      const [headline = "", row = ""] = framed
      return [
        this.colorTaskHeadline(headline, animationFrame),
        this.colorTaskRow(row),
      ]
    }

    const [headline, ...rows] = framed

    return [
      this.colorTaskHeadline(headline ?? "", animationFrame),
      ...rows.map(row => this.colorTaskRow(row)),
    ]
  }

  invalidate(): void {}

  dispose(): void {}
}
