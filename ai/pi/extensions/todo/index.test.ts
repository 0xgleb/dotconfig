import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import type { Theme } from "@earendil-works/pi-coding-agent"
import { visibleWidth } from "@earendil-works/pi-tui"
import { KANBAN_OVERLAY_OPTIONS, KanbanComponent } from "./kanban.ts"
import type { TodoState } from "./state.ts"

const todoExtensionSource = readFileSync(
  new URL("./index.ts", import.meta.url),
  "utf8",
)

const state: TodoState = {
  nextId: 6,
  todos: [
    { id: 1, text: "Finished", status: "completed" },
    { id: 2, text: "Working", status: "in_progress" },
    { id: 3, text: "Queued", status: "pending" },
    { id: 4, text: "Blocked", status: "blocked", reason: "Waiting" },
    { id: 5, text: "Awaiting review", status: "in_review" },
  ],
}

test("kanban overlay is centered within the current Pi pane", () => {
  assert.deepEqual(KANBAN_OVERLAY_OPTIONS, {
    anchor: "center",
    width: "72%",
    minWidth: 64,
    maxHeight: "80%",
    margin: 2,
  })
})

test("kanban renders a glass-backed frame in project-status order", () => {
  let backgroundCalls = 0
  const theme = {
    fg: (_color: string, text: string) => text,
    bg: (_color: string, text: string) => {
      backgroundCalls += 1
      return text
    },
    bold: (text: string) => text,
  } as unknown as Theme
  const lines = new KanbanComponent(state, theme, () => {}).render(90)
  const headings = lines.find(
    (line) =>
      line.includes("TODO") &&
      line.includes("IN PROGRESS") &&
      line.includes("IN REVIEW") &&
      line.includes("DONE"),
  )

  assert.ok(headings)
  assert.ok(headings.indexOf("TODO") < headings.indexOf("IN PROGRESS"))
  assert.ok(headings.indexOf("IN PROGRESS") < headings.indexOf("IN REVIEW"))
  assert.ok(headings.indexOf("IN REVIEW") < headings.indexOf("DONE"))
  assert.match(lines[0] ?? "", /^╭.*KANBAN.*20% done.*╮$/)
  assert.match(lines.at(-1) ?? "", /^╰─+╯$/)
  assert.ok(backgroundCalls >= lines.length - 2)
  for (const line of lines) assert.equal(visibleWidth(line), 90)
})

test("kanban supports Vim navigation and wrapped task details", () => {
  let changes = 0
  let closed = false
  const theme = {
    fg: (_color: string, text: string) => text,
    bg: (_color: string, text: string) => text,
    bold: (text: string) => text,
  } as unknown as Theme
  const component = new KanbanComponent(
    state,
    theme,
    () => {
      closed = true
    },
    () => {
      changes += 1
    },
  )

  assert.match(component.render(90).join("\n"), /› \[ \] #3 Queued/)
  component.handleInput("G")
  component.handleInput("\r")
  const blockedDetail = component.render(90).join("\n")
  assert.match(blockedDetail, /KANBAN DETAIL/)
  assert.match(blockedDetail, /#4 · blocked/)
  assert.match(blockedDetail, /Blocked:/)
  assert.match(blockedDetail, /Waiting/)

  component.handleInput("\x1b")
  assert.match(component.render(90).join("\n"), /TODO.*IN PROGRESS/)
  component.handleInput("l")
  component.handleInput(" ")
  assert.match(component.render(90).join("\n"), /#2 · in progress/)
  component.handleInput("\x1b")
  component.handleInput("\x1b")

  assert.equal(closed, true)
  assert.ok(changes >= 5)
})

test("kanban unblocks the selected blocked task directly", async () => {
  let unblockedId: number | undefined
  const theme = {
    fg: (_color: string, text: string) => text,
    bg: (_color: string, text: string) => text,
    bold: (text: string) => text,
  } as unknown as Theme
  const component = new KanbanComponent(
    state,
    theme,
    () => {},
    () => {},
    async (todo) => {
      unblockedId = todo.id
      return {
        ...state,
        todos: state.todos.map((candidate) =>
          candidate.id === todo.id
            ? { id: candidate.id, text: candidate.text, status: "pending" as const }
            : candidate,
        ),
      }
    },
  )

  component.handleInput("G")
  assert.match(component.render(90).join("\n"), /u unblock/)
  component.handleInput("u")
  await new Promise((resolve) => setTimeout(resolve, 0))

  assert.equal(unblockedId, 4)
  assert.match(component.render(90).join("\n"), /\[ \] #4 Blocked/)
})

test("task progress animation blinks at varied rates without a green success pulse", () => {
  const renderer = todoExtensionSource.slice(
    todoExtensionSource.indexOf("private colorTaskHeadline"),
    todoExtensionSource.indexOf("private colorTaskRow"),
  )
  assert.doesNotMatch(renderer, /"success"/)
  assert.match(renderer, /taskProgressBlinkRate/)
  assert.match(renderer, /SLOW_BLINK|RAPID_BLINK/)
})

test("task progress pulse animates only while an agent is running", () => {
  assert.match(todoExtensionSource, /HUD_ANIMATION_INTERVAL_MS = 180/)
  assert.match(
    todoExtensionSource,
    /agentRunning &&[\s\S]*?setInterval[\s\S]*?hudAnimationFrame \+= 1/,
  )
  assert.match(
    todoExtensionSource,
    /pi\.on\("agent_start"[\s\S]*?agentRunning = true/,
  )
  assert.match(
    todoExtensionSource,
    /pi\.on\("agent_settled"[\s\S]*?agentRunning = false/,
  )
  assert.match(
    todoExtensionSource,
    /session_shutdown[\s\S]*?clearInterval\(hudAnimation\)/,
  )
})

test("kanban reapplies its glass background after nested foreground resets", () => {
  const backgroundPrefix = "\x1b[48;2;24;20;58m"
  const backgroundSuffix = "\x1b[49m"
  const theme = {
    fg: (_color: string, text: string) =>
      `\x1b[38;2;232;246;255m${text}\x1b[0m`,
    bg: (_color: string, text: string) =>
      `${backgroundPrefix}${text}${backgroundSuffix}`,
    bold: (text: string) => `\x1b[1m${text}\x1b[0m`,
  } as unknown as Theme
  const lines = new KanbanComponent(state, theme, () => {}).render(90)

  for (const line of lines.slice(1, -1)) {
    const backgroundStart = line.indexOf(backgroundPrefix)
    const backgroundEnd = line.lastIndexOf(backgroundSuffix)
    assert.ok(
      backgroundStart >= 0,
      "every interior row starts the glass background",
    )
    assert.ok(
      backgroundEnd > backgroundStart,
      "every interior row closes the glass background",
    )
    const interior = line.slice(
      backgroundStart + backgroundPrefix.length,
      backgroundEnd,
    )
    assert.doesNotMatch(interior, /\x1b\[0m(?!\x1b\[48;2;24;20;58m)/)
    assert.equal(visibleWidth(line), 90)
  }
})
