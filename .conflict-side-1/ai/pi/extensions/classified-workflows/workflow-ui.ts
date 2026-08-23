import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui"
import { activeWorkflowHudLines } from "./workflow-hud.ts"

export type WorkflowUiStatus = "running" | "completed" | "failed" | "cancelled"

export interface WorkflowProgressSnapshot {
  readonly purpose: string
  readonly phase?: string
  readonly started: number
  readonly running: number
  readonly completed: number
  readonly failed: number
  readonly maxAgents: number
  readonly latest?: string
}

export const workflowProgressText = (
  snapshot: WorkflowProgressSnapshot,
): string => {
  const settled = snapshot.completed + snapshot.failed
  return [
    snapshot.purpose,
    ...(snapshot.phase ? [`phase ${snapshot.phase}`] : []),
    `progress ${settled} settled / ${snapshot.running} running / ${snapshot.started} started (${snapshot.completed} ok, ${snapshot.failed} failed; max ${snapshot.maxAgents}/phase)`,
    ...(snapshot.latest ? [`latest ${snapshot.latest}`] : []),
  ].join(" · ")
}

export interface WorkflowUiChild {
  readonly index: number
  readonly task: string
  readonly model: string
  readonly tools: string
  readonly status: "running" | "completed" | "blocked" | "failed" | "timed-out"
  readonly elapsed: string
  readonly latest?: string
}

export interface WorkflowUiItem {
  readonly id: string
  readonly label: string
  readonly status: WorkflowUiStatus
  readonly elapsed: string
  readonly limits: string
  readonly outcome?: string
  readonly progress?: string
  readonly phase?: string
  readonly children?: ReadonlyArray<WorkflowUiChild>
}

export const activeWorkflowLines: (
  items: ReadonlyArray<WorkflowUiItem>,
) => string[] = items => {
  const running = items.filter(({ status }) => status === "running")
  if (running.length === 0) return []
  return [
    `WORKFLOWS · ${running.length} active · /workflows for history`,
    ...running.flatMap(({ id, label, elapsed, limits, progress }) => [
      `● ${id} · ${label} · running ${elapsed}`,
      `↳ ${progress ?? "initializing"} · ${limits}`,
    ]),
  ]
}

export const activeWorkflowPanelLines = activeWorkflowHudLines

export const backgroundWorkflowStartedText: (
  id: string,
  label: string,
) => string = (id, label) =>
  `Started background workflow ${id}: ${label}. It owns the delegated task; keep the foreground focused and do not duplicate that work unless the workflow fails or the user reprioritizes it. Use /workflows status, /workflows result ${id}, or /workflows cancel ${id}.`

export const workflowHistoryText: (
  items: ReadonlyArray<WorkflowUiItem>,
) => string = items => {
  if (items.length === 0)
    return "No background workflow history in this session."
  return items
    .flatMap(item => {
      const icon = {
        running: "●",
        completed: "✓",
        failed: "✕",
        cancelled: "◌",
      }[item.status]
      const summary = `${icon} ${item.id} · ${item.status} · ${item.label} · ${item.elapsed} · ${item.limits}`
      return item.outcome
        ? [summary, `  ${compactOutcome(item.outcome)}`]
        : [summary]
    })
    .join("\n")
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const structuredCellText = (value: unknown): string => {
  if (value === null || value === undefined || value === "") return "—"
  if (typeof value === "number")
    return Number.isFinite(value)
      ? value.toLocaleString("en-US")
      : String(value)
  if (typeof value === "boolean" || typeof value === "bigint")
    return String(value)
  if (typeof value === "string")
    return value
      .replace(/[\u0000-\u001f\u007f]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
  if (Array.isArray(value)) return `${value.length} items`
  if (isRecord(value)) return `${Object.keys(value).length} fields`
  return String(value).replace(/\s+/g, " ").trim()
}

const padTableCell = (value: string, width: number): string => {
  const truncated = truncateToWidth(value, width, "…")
  return `${truncated}${" ".repeat(Math.max(0, width - visibleWidth(truncated)))}`
}

const compactStructuredRows = (
  rows: ReadonlyArray<Readonly<Record<string, unknown>>>,
  keys: readonly string[],
  width: number,
): string[] =>
  rows.map((row, index) => {
    const identity = [
      String(index + 1),
      ...keys.slice(0, 2).map(key => structuredCellText(row[key])),
    ].join(" · ")
    const summaryKey = keys.find(key => key === "output") ?? keys.at(2)
    const summary = summaryKey ? structuredCellText(row[summaryKey]) : ""
    return truncateToWidth(
      summary && !identity.includes(summary)
        ? `${identity} · ${summary}`
        : identity,
      width,
      "…",
    )
  })

export const workflowStructuredResultValue = (
  result: unknown,
): Readonly<Record<string, unknown>> | readonly unknown[] | undefined => {
  if (Array.isArray(result) || isRecord(result)) return result
  if (typeof result !== "string") return undefined
  const trimmed = result.trim()
  if (
    trimmed.length === 0 ||
    trimmed.length > 2_000_000 ||
    (!trimmed.startsWith("[") && !trimmed.startsWith("{"))
  )
    return undefined
  try {
    const parsed: unknown = JSON.parse(trimmed)
    return Array.isArray(parsed) || isRecord(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

export const workflowStructuredResultTableLines = (
  result: unknown,
  width: number,
): string[] => {
  const safeWidth = Math.max(1, Math.floor(width))
  const rows = Array.isArray(result)
    ? result.map(value => (isRecord(value) ? value : { value }))
    : isRecord(result)
      ? Object.entries(result).map(([key, value]) => ({ key, value }))
      : [{ value: result }]
  if (rows.length === 0) return ["(empty result)"]

  const discovered = [...new Set(rows.flatMap(row => Object.keys(row)))]
  const preferred = ["status", "usageTokens", "output", "diagnostic"]
  const keys = [
    ...preferred.filter(key => discovered.includes(key)),
    ...discovered.filter(key => !preferred.includes(key)),
  ].slice(0, 5)
  const headers = ["#", ...keys]
  const overhead = headers.length * 3 + 1
  const baseWidths = headers.map(header => {
    if (header === "#") return 3
    if (header === "status") return 12
    if (header === "usageTokens") return 12
    return Math.max(12, Math.min(18, visibleWidth(header)))
  })
  const minimumWidth =
    overhead + baseWidths.reduce((sum, value) => sum + value, 0)
  if (safeWidth < minimumWidth)
    return compactStructuredRows(rows, keys, safeWidth)

  const widths = [...baseWidths]
  let spare = safeWidth - minimumWidth
  const flexible = headers
    .map((header, index) => ({ header, index }))
    .filter(({ header }) => !["#", "status", "usageTokens"].includes(header))
  const targets =
    flexible.length > 0
      ? flexible
      : headers.map((header, index) => ({ header, index }))
  for (let cursor = 0; spare > 0; cursor += 1) {
    widths[targets[cursor % targets.length]!.index]! += 1
    spare -= 1
  }

  const border = (left: string, middle: string, right: string): string =>
    `${left}${widths.map(value => "─".repeat(value + 2)).join(middle)}${right}`
  const tableRow = (values: readonly string[]): string =>
    `│${values.map((value, index) => ` ${padTableCell(value, widths[index] ?? 1)} `).join("│")}│`

  return [
    border("╭", "┬", "╮"),
    tableRow(headers),
    border("├", "┼", "┤"),
    ...rows
      .slice(0, 50)
      .map((row, index) =>
        tableRow([
          String(index + 1),
          ...keys.map(key => structuredCellText(row[key])),
        ]),
      ),
    ...(rows.length > 50
      ? [
          tableRow([
            "…",
            `${rows.length - 50} more rows`,
            ...keys.slice(1).map(() => ""),
          ]),
        ]
      : []),
    border("╰", "┴", "╯"),
  ]
}

const compactOutcome: (outcome: string) => string = outcome => {
  const singleLine = outcome.replace(/\s+/g, " ").trim()
  return singleLine.length <= 240
    ? singleLine
    : `${singleLine.slice(0, 237)}...`
}
