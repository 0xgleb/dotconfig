import assert from "node:assert/strict"
import test from "node:test"
import type { Theme } from "@earendil-works/pi-coding-agent"
import { visibleWidth } from "@earendil-works/pi-tui"
import { KanbanComponent } from "./kanban.ts"
import type { TodoState } from "./state.ts"

const theme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as unknown as Theme

test("narrow child cards retain task text and their root link", () => {
  const state: TodoState = {
    nextId: 3,
    todos: [
      { id: 1, text: "Root", status: "completed" },
      { id: 2, text: "Ship", status: "pending", parentId: 1 },
    ],
  }
  const board = new KanbanComponent(state, theme, () => {})
  const lines = board.render(64)
  assert.ok(lines.some(line => line.includes("Ship")))
  assert.ok(lines.some(line => line.includes("↳ #1")))
  assert.ok(lines.every(line => visibleWidth(line) <= 64))
  board.handleInput("\r")
  assert.match(board.render(64).join("\n"), /subtask of #1/)
})
