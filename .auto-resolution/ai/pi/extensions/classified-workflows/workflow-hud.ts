import type { Theme } from "@earendil-works/pi-coding-agent"
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui"

import { framedChromeInset } from "../shared/chrome.ts"
import type { WorkflowUiItem } from "./workflow-ui.ts"

const FRAME_GUTTER = 3

interface WorkflowRule {
  readonly left: string
  readonly right: string
}

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

const rule = (inner: number, labels: WorkflowRule): string => {
  if (inner <= 0) return ""
  const border = (count: number): string => "─".repeat(Math.max(0, count))
  const [headRoom, tailRoom] = share(
    visibleWidth(labels.left),
    visibleWidth(labels.right),
    inner - 3,
  )
  const head = truncateToWidth(labels.left, headRoom, "…")
  const tail = truncateToWidth(labels.right, tailRoom, "…")
  const headWidth = visibleWidth(head)
  const tailWidth = visibleWidth(tail)
  if (headWidth === 0 && tailWidth === 0) return border(inner)
  if (tailWidth === 0) return `${head} ${border(inner - headWidth - 1)}`
  if (headWidth === 0) return `${border(inner - tailWidth - 1)} ${tail}`
  return `${head} ${border(inner - headWidth - tailWidth - 2)} ${tail}`
}

export const activeWorkflowHudLines = (
  items: ReadonlyArray<WorkflowUiItem>,
  width: number,
): string[] => {
  const running = items.filter(({ status }) => status === "running")
  if (running.length === 0 || width <= 0) return []
  if (width < FRAME_GUTTER * 2) return ["─".repeat(width)]

  const inset = framedChromeInset(width)
  const frameWidth = width - inset * 2
  const inner = Math.max(0, frameWidth - FRAME_GUTTER * 2)
  const leftMargin = " ".repeat(inset)
  const rightMargin = " ".repeat(width - inset - frameWidth)
  const framed = (line: string): string => `${leftMargin}${line}${rightMargin}`
  const pad = (text: string): string => {
    const content = truncateToWidth(text, inner, "…")
    return `${content}${" ".repeat(Math.max(0, inner - visibleWidth(content)))}`
  }

  const childMark = (
    status: NonNullable<WorkflowUiItem["children"]>[number]["status"],
  ): string =>
    ({
      "running": "◉",
      "completed": "✓",
      "blocked": "!",
      "failed": "✕",
      "timed-out": "◷",
    })[status]

  const workflowRows = running.flatMap(
    ({ id, label, elapsed, limits, progress, phase, children = [] }) => [
      `● ${id}  ·  ${label}  ·  running ${elapsed}`,
      `↳ ${phase ? `phase ${phase}  ·  ` : ""}${limits}`,
      ...(children.length === 0
        ? [progress ?? "initializing"]
        : children.flatMap(child => [
            `${childMark(child.status)} child ${String(child.index).padStart(2, "0")}  ·  ${child.status}  ·  ${child.model}  ·  ${child.elapsed}  ·  tools ${child.tools}`,
            `  task  ${child.task}`,
            ...(child.status === "running" && child.latest
              ? [`  now   ${child.latest}`]
              : []),
          ])),
    ],
  )

  return [
    framed(
      `╭─ ${rule(inner, {
        left: `WORKFLOWS  ·  ${running.length} active`,
        right: "/workflows",
      })} ─╮`,
    ),
    ...workflowRows.map(row => framed(`│  ${pad(row)}  │`)),
  ]
}

const colorWorkflowRow = (line: string, theme: Theme): string => {
  const firstBorder = line.indexOf("│")
  const lastBorder = line.lastIndexOf("│")
  if (firstBorder < 0 || lastBorder <= firstBorder)
    return theme.fg("accent", line)
  return [
    theme.fg("borderAccent", line.slice(0, firstBorder + 1)),
    theme.fg("accent", line.slice(firstBorder + 1, lastBorder)),
    theme.fg("borderAccent", line.slice(lastBorder)),
  ].join("")
}

export class WorkflowHudComponent {
  private readonly items: () => ReadonlyArray<WorkflowUiItem>
  private readonly theme: Theme

  constructor(items: () => ReadonlyArray<WorkflowUiItem>, theme: Theme) {
    this.items = items
    this.theme = theme
  }

  render(width: number): string[] {
    const [headline, ...rows] = activeWorkflowHudLines(this.items(), width)
    if (headline === undefined) return []
    return [
      this.theme.bold(this.theme.fg("borderAccent", headline)),
      ...rows.map(row => colorWorkflowRow(row, this.theme)),
    ]
  }

  invalidate(): void {}
}
