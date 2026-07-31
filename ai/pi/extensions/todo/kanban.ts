import type { Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, type OverlayOptions, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { kanbanColumns, overlayRule, todoSummary } from "./presentation.ts";
import { todoStatusMark, type Todo, type TodoState } from "./state.ts";

export const KANBAN_OVERLAY_OPTIONS = {
  anchor: "center",
  width: "72%",
  minWidth: 64,
  maxHeight: "80%",
  margin: 2,
} satisfies OverlayOptions;

export class KanbanComponent {
  private readonly state: TodoState;
  private readonly theme: Theme;
  private readonly onClose: () => void;
  private cachedWidth?: number;
  private cachedLines?: string[];

  constructor(state: TodoState, theme: Theme, onClose: () => void) {
    this.state = state;
    this.theme = theme;
    this.onClose = onClose;
  }

  handleInput(data: string): void {
    if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) this.onClose();
  }

  render(width: number): string[] {
    if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;

    const summary = todoSummary(this.state);
    const columns = kanbanColumns(this.state);
    const separator = this.theme.fg("borderMuted", " │ ");
    const innerWidth = Math.max(3, width - 2);
    const available = Math.max(3, innerWidth - 6);
    const baseWidth = Math.floor(available / 3);
    const columnWidths = [baseWidth, baseWidth, available - baseWidth * 2] as const;
    const next = this.cardLines(columns.next, "accent", 18, "Queue clear");
    const now = this.cardLines(columns.now, "warning", 18, "Nothing active");
    const done = this.cardLines(columns.done.slice().reverse(), "success", 18, "Nothing done yet");
    const rowCount = Math.max(next.length, now.length, done.length);
    const top = overlayRule(
      {
        left: "KANBAN",
        right: `${summary.completed}/${summary.total} complete  ·  ${summary.pending} active  ·  ${summary.blocked} blocked`,
      },
      width,
    );
    const lines = [
      this.theme.bold(this.theme.fg("borderAccent", `╭${top.slice(1, -1)}╮`)),
      this.glassLine("", innerWidth),
      this.glassLine(
        this.row(
          [
            this.theme.fg("accent", this.theme.bold("NEXT")),
            this.theme.fg("warning", this.theme.bold("NOW")),
            this.theme.fg("success", this.theme.bold("DONE")),
          ],
          columnWidths,
          separator,
        ),
        innerWidth,
      ),
      this.glassLine(
        this.row(
          columnWidths.map((columnWidth) => this.theme.fg("borderMuted", "─".repeat(columnWidth))),
          columnWidths,
          separator,
        ),
        innerWidth,
      ),
    ];

    for (let index = 0; index < rowCount; index += 1) {
      lines.push(
        this.glassLine(
          this.row([next[index] ?? "", now[index] ?? "", done[index] ?? ""], columnWidths, separator),
          innerWidth,
        ),
      );
    }

    lines.push(
      this.glassLine("", innerWidth),
      this.glassLine(this.theme.fg("dim", " Esc closes · session remains visible behind this board"), innerWidth),
      this.glassLine("", innerWidth),
      this.theme.fg("borderMuted", `╰${"─".repeat(innerWidth)}╯`),
    );
    this.cachedWidth = width;
    this.cachedLines = lines;
    return lines;
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
  }

  private cardLines(
    todos: ReadonlyArray<Todo>,
    color: "accent" | "success" | "warning",
    limit: number,
    emptyLabel: string,
  ): string[] {
    if (todos.length === 0) return [this.theme.fg("dim", emptyLabel)];
    const visible = todos.slice(0, limit).map(
      (todo) => `${this.theme.fg(color, todoStatusMark(todo.status))} ${this.theme.fg("accent", `#${todo.id}`)} ${todo.text}`,
    );
    if (todos.length > visible.length) visible.push(this.theme.fg("dim", `… ${todos.length - visible.length} more`));
    return visible;
  }

  private glassLine(content: string, width: number): string {
    return `${this.theme.fg("borderMuted", "│")}${this.theme.bg("customMessageBg", this.padCell(content, width))}${this.theme.fg("borderMuted", "│")}`;
  }

  private row(cells: readonly string[], widths: readonly [number, number, number], separator: string): string {
    return cells.map((cell, index) => this.padCell(cell, widths[index] ?? 0)).join(separator);
  }

  private padCell(content: string, width: number): string {
    const truncated = truncateToWidth(content, width, "");
    return truncated + " ".repeat(Math.max(0, width - visibleWidth(truncated)));
  }
}
