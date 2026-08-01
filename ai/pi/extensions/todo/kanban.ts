import type { Theme } from "@earendil-works/pi-coding-agent"
import {
  matchesKey,
  type OverlayOptions,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui"
import { kanbanColumns, overlayRule, todoSummary } from "./presentation.ts"
import { todoStatusMark, type Todo, type TodoState } from "./state.ts"

export const KANBAN_OVERLAY_OPTIONS = {
  anchor: "center",
  width: "72%",
  minWidth: 64,
  maxHeight: "80%",
  margin: 2,
} satisfies OverlayOptions

export class KanbanComponent {
  private readonly state: TodoState
  private readonly theme: Theme
  private readonly onClose: () => void
  private readonly onChange: () => void
  private selectedColumn = 0
  private readonly selectedRows = [0, 0, 0, 0]
  private detailOpen = false
  private cachedWidth?: number
  private cachedLines?: string[]

  constructor(
    state: TodoState,
    theme: Theme,
    onClose: () => void,
    onChange: () => void = () => {},
  ) {
    this.state = state
    this.theme = theme
    this.onClose = onClose
    this.onChange = onChange
  }

  handleInput(data: string): void {
    if (matchesKey(data, "ctrl+c")) {
      this.onClose()
      return
    }
    if (matchesKey(data, "escape")) {
      if (this.detailOpen) {
        this.detailOpen = false
        this.changed()
      } else {
        this.onClose()
      }
      return
    }
    if (this.detailOpen) return

    if (matchesKey(data, "left") || data === "h") {
      this.selectedColumn = Math.max(0, this.selectedColumn - 1)
      this.changed()
      return
    }
    if (matchesKey(data, "right") || data === "l") {
      this.selectedColumn = Math.min(3, this.selectedColumn + 1)
      this.changed()
      return
    }

    const todos = this.columnTodos()[this.selectedColumn] ?? []
    if (todos.length === 0) return
    const current = this.selectedRows[this.selectedColumn] ?? 0
    if (matchesKey(data, "up") || data === "k") {
      this.selectedRows[this.selectedColumn] = Math.max(0, current - 1)
      this.changed()
      return
    }
    if (matchesKey(data, "down") || data === "j") {
      this.selectedRows[this.selectedColumn] = Math.min(
        todos.length - 1,
        current + 1,
      )
      this.changed()
      return
    }
    if (data === "g" || matchesKey(data, "home")) {
      this.selectedRows[this.selectedColumn] = 0
      this.changed()
      return
    }
    if (data === "G" || matchesKey(data, "end")) {
      this.selectedRows[this.selectedColumn] = todos.length - 1
      this.changed()
      return
    }
    if (matchesKey(data, "enter") || matchesKey(data, "space")) {
      this.detailOpen = true
      this.changed()
    }
  }

  render(width: number): string[] {
    if (this.cachedLines && this.cachedWidth === width) return this.cachedLines

    const selected = this.selectedTodo()
    if (this.detailOpen && selected) return this.renderDetail(selected, width)

    const summary = todoSummary(this.state)
    const columns = this.columnTodos()
    const separator = this.theme.fg("borderMuted", " │ ")
    const innerWidth = Math.max(3, width - 2)
    const available = Math.max(4, innerWidth - 9)
    const baseWidth = Math.floor(available / 4)
    const columnWidths = [
      baseWidth,
      baseWidth,
      baseWidth,
      available - baseWidth * 3,
    ] as const
    const todo = this.cardLines(columns[0], 0, "accent", 18, "Queue clear")
    const inProgress = this.cardLines(
      columns[1],
      1,
      "warning",
      18,
      "Nothing active",
    )
    const inReview = this.cardLines(
      columns[2],
      2,
      "toolTitle",
      18,
      "Nothing in review",
    )
    const done = this.cardLines(
      columns[3],
      3,
      "success",
      18,
      "Nothing done yet",
    )
    const rowCount = Math.max(
      todo.length,
      inProgress.length,
      inReview.length,
      done.length,
    )
    const top = overlayRule(
      {
        left: "KANBAN",
        right: `${summary.completed}/${summary.total} complete  ·  ${summary.pending} active  ·  ${summary.blocked} blocked`,
      },
      width,
    )
    const lines = [
      this.theme.bold(this.theme.fg("borderAccent", `╭${top.slice(1, -1)}╮`)),
      this.glassLine("", innerWidth),
      this.glassLine(
        this.row(
          [
            this.columnHeading("TODO", "accent", 0),
            this.columnHeading("IN PROGRESS", "warning", 1),
            this.columnHeading("IN REVIEW", "toolTitle", 2),
            this.columnHeading("DONE", "success", 3),
          ],
          columnWidths,
          separator,
        ),
        innerWidth,
      ),
      this.glassLine(
        this.row(
          columnWidths.map((columnWidth) =>
            this.theme.fg("borderMuted", "─".repeat(columnWidth)),
          ),
          columnWidths,
          separator,
        ),
        innerWidth,
      ),
    ]

    for (let index = 0; index < rowCount; index += 1) {
      lines.push(
        this.glassLine(
          this.row(
            [
              todo[index] ?? "",
              inProgress[index] ?? "",
              inReview[index] ?? "",
              done[index] ?? "",
            ],
            columnWidths,
            separator,
          ),
          innerWidth,
        ),
      )
    }

    lines.push(
      this.glassLine("", innerWidth),
      this.glassLine(
        this.theme.fg(
          "dim",
          " h/l columns · j/k tasks · g/G ends · Enter/Space detail · Esc close",
        ),
        innerWidth,
      ),
      this.glassLine("", innerWidth),
      this.theme.fg("borderMuted", `╰${"─".repeat(innerWidth)}╯`),
    )
    this.cachedWidth = width
    this.cachedLines = lines
    return lines
  }

  invalidate(): void {
    this.cachedWidth = undefined
    this.cachedLines = undefined
  }

  private cardLines(
    todos: ReadonlyArray<Todo>,
    column: number,
    color: "accent" | "success" | "warning" | "toolTitle",
    limit: number,
    emptyLabel: string,
  ): string[] {
    if (todos.length === 0) return [this.theme.fg("dim", emptyLabel)]
    const selected = Math.min(todos.length - 1, this.selectedRows[column] ?? 0)
    this.selectedRows[column] = selected
    const start = Math.min(
      Math.max(0, selected - limit + 1),
      Math.max(0, todos.length - limit),
    )
    return todos.slice(start, start + limit).map((todo, visibleIndex) => {
      const taskIndex = start + visibleIndex
      const marker =
        column === this.selectedColumn && taskIndex === selected ? "›" : " "
      return `${this.theme.fg("accent", marker)} ${this.theme.fg(color, todoStatusMark(todo.status))} ${this.theme.fg("accent", `#${todo.id}`)} ${this.theme.fg("text", todo.text)}`
    })
  }

  private columnTodos(): readonly [
    ReadonlyArray<Todo>,
    ReadonlyArray<Todo>,
    ReadonlyArray<Todo>,
    ReadonlyArray<Todo>,
  ] {
    const columns = kanbanColumns(this.state)
    return [
      columns.todo,
      columns.inProgress,
      columns.inReview,
      columns.done.slice().reverse(),
    ]
  }

  private selectedTodo(): Todo | undefined {
    const todos = this.columnTodos()[this.selectedColumn] ?? []
    const selected = this.selectedRows[this.selectedColumn] ?? 0
    return todos[selected]
  }

  private columnHeading(
    label: string,
    color: "accent" | "success" | "warning" | "toolTitle",
    column: number,
  ): string {
    const heading = this.theme.fg(color, this.theme.bold(label))
    return column === this.selectedColumn
      ? this.theme.bg("selectedBg", heading)
      : heading
  }

  private renderDetail(todo: Todo, width: number): string[] {
    const innerWidth = Math.max(3, width - 2)
    const contentWidth = Math.max(1, innerWidth - 4)
    const details = [
      this.theme.fg(
        "accent",
        this.theme.bold(`#${todo.id} · ${todo.status.replaceAll("_", " ")}`),
      ),
      "",
      ...wrapTextWithAnsi(this.theme.fg("text", todo.text), contentWidth),
    ]
    if (todo.status === "blocked") {
      details.push(
        "",
        this.theme.fg("warning", this.theme.bold("Blocked:")),
        ...wrapTextWithAnsi(this.theme.fg("text", todo.reason), contentWidth),
      )
    }
    if (todo.status === "deferred" && todo.remindAt !== undefined) {
      details.push(
        "",
        this.theme.fg(
          "muted",
          `Deferred until ${new Date(todo.remindAt).toISOString()}`,
        ),
      )
    }
    if (todo.replies && todo.replies.length > 0) {
      details.push("", this.theme.fg("muted", this.theme.bold("Replies:")))
      for (const reply of todo.replies) {
        details.push(
          ...wrapTextWithAnsi(
            this.theme.fg("text", `• ${reply}`),
            contentWidth,
          ),
        )
      }
    }

    const top = overlayRule(
      { left: "KANBAN DETAIL", right: `#${todo.id}` },
      width,
    )
    const lines = [
      this.theme.bold(this.theme.fg("borderAccent", `╭${top.slice(1, -1)}╮`)),
      this.glassLine("", innerWidth),
      ...details.map((line) => this.glassLine(`  ${line}`, innerWidth)),
      this.glassLine("", innerWidth),
      this.glassLine(this.theme.fg("dim", " Esc returns to board"), innerWidth),
      this.glassLine("", innerWidth),
      this.theme.fg("borderMuted", `╰${"─".repeat(innerWidth)}╯`),
    ]
    this.cachedWidth = width
    this.cachedLines = lines
    return lines
  }

  private changed(): void {
    this.invalidate()
    this.onChange()
  }

  private glassLine(content: string, width: number): string {
    const padded = this.padCell(content, width)
    const sentinel = "\u0000"
    const sample = this.theme.bg("customMessageBg", sentinel)
    const sentinelIndex = sample.indexOf(sentinel)
    if (sentinelIndex === -1) {
      return `${this.theme.fg("borderMuted", "│")}${this.theme.bg("customMessageBg", padded)}${this.theme.fg("borderMuted", "│")}`
    }
    const backgroundPrefix = sample.slice(0, sentinelIndex)
    const backgroundSuffix = sample.slice(sentinelIndex + sentinel.length)
    const resetSafe = padded.replace(
      /\x1b\[(?:0|49)m/g,
      (reset) => `${reset}${backgroundPrefix}`,
    )
    return `${this.theme.fg("borderMuted", "│")}${backgroundPrefix}${resetSafe}${backgroundSuffix}${this.theme.fg("borderMuted", "│")}`
  }

  private row(
    cells: readonly string[],
    widths: readonly [number, number, number, number],
    separator: string,
  ): string {
    return cells
      .map((cell, index) => this.padCell(cell, widths[index] ?? 0))
      .join(separator)
  }

  private padCell(content: string, width: number): string {
    const truncated = truncateToWidth(content, width, "")
    return truncated + " ".repeat(Math.max(0, width - visibleWidth(truncated)))
  }
}
