import type { Theme } from "@earendil-works/pi-coding-agent"

import {
  frameTaskHud,
  taskHud,
  taskProgressCellPulse,
} from "./presentation.ts"
import type { TodoState } from "./state.ts"

export const HUD_ANIMATION_INTERVAL_MS = 500

const brightenTruecolorForeground = (text: string): string | undefined => {
  const color = /\x1b\[38;2;(\d+);(\d+);(\d+)m/u
  const match = color.exec(text)
  if (!match) return undefined
  const channels = match.slice(1).map(Number)
  if (channels.some((channel) => channel < 0 || channel > 255)) return undefined
  const [red = 0, green = 0, blue = 0] = channels.map((channel) =>
    Math.round(channel + (255 - channel) * 0.35),
  )
  return text.replace(color, `\x1b[38;2;${red};${green};${blue}m`)
}

export const synchronizedTaskHudFrame = (
  now: number,
  intervalMs = HUD_ANIMATION_INTERVAL_MS,
): number => {
  if (!Number.isSafeInteger(now) || now < 0)
    throw new RangeError("task HUD timestamp must be a non-negative integer")
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 1)
    throw new RangeError("task HUD interval must be a positive integer")
  return Math.floor(now / intervalMs)
}

export class TaskHudComponent {
  private readonly state: TodoState
  private readonly theme: Theme
  private readonly requestRender: () => void
  private readonly animationIntervalMs: number
  private animationTimer: ReturnType<typeof setInterval> | undefined

  constructor(
    state: TodoState,
    theme: Theme,
    requestRender: () => void = () => {},
    animationIntervalMs = HUD_ANIMATION_INTERVAL_MS,
  ) {
    this.state = state
    this.theme = theme
    this.requestRender = requestRender
    this.animationIntervalMs = animationIntervalMs
    const hasUnfinishedWork = state.todos.some(
      ({ status }) => status !== "completed" && status !== "cancelled",
    )
    if (hasUnfinishedWork && animationIntervalMs > 0) {
      this.animationTimer = setInterval(() => {
        this.requestRender()
      }, animationIntervalMs)
      this.animationTimer.unref()
    }
  }

  private colorTaskHeadline(line: string, animationFrame: number): string {
    const progressBar = /([▰▱]{8})/u
    return line
      .split(progressBar)
      .map((part) =>
        progressBar.test(part)
          ? [...part]
              .map((cell, index) => {
                if (cell !== "▰" && cell !== "▱") return cell
                const frontierIndex = part.lastIndexOf("▰")
                const pulseOn = taskProgressCellPulse(
                  cell,
                  animationFrame,
                  index,
                  frontierIndex,
                )
                const hued = this.theme.fg(
                  cell === "▰" ? "accent" : "muted",
                  cell,
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
    const animationFrame = synchronizedTaskHudFrame(
      Date.now(),
      this.animationIntervalMs,
    )
    const hud = taskHud(this.state)
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
      ...rows.map((row) => this.colorTaskRow(row)),
    ]
  }

  invalidate(): void {}

  dispose(): void {
    if (this.animationTimer) clearInterval(this.animationTimer)
    this.animationTimer = undefined
  }
}
