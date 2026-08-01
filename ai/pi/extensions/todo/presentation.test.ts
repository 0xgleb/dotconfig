import assert from "node:assert/strict"
import test from "node:test"
import { visibleWidth } from "@earendil-works/pi-tui"
import {
  frameTaskHud,
  kanbanColumns,
  taskHud,
  taskHudLines,
  taskWidgetLines,
  todoSummary,
  topPendingTodos,
} from "./presentation.ts"
import type { TodoState } from "./state.ts"

const state: TodoState = {
  nextId: 6,
  todos: [
    { id: 1, text: "Inspect handover", status: "completed" },
    { id: 2, text: "Fix classifier", status: "pending" },
    { id: 3, text: "Add task overlay", status: "pending" },
    { id: 4, text: "Run smoke tests", status: "pending" },
    {
      id: 5,
      text: "Ship release",
      status: "blocked",
      reason: "Waiting for production access",
    },
  ],
}

test("todo summary counts pending, blocked, and completed tasks", () => {
  assert.deepEqual(todoSummary(state), {
    total: 5,
    completed: 1,
    pending: 3,
    inProgress: 0,
    inReview: 0,
    blocked: 1,
    deferred: 0,
    cancelled: 0,
  })
})

test("top pending todos preserve task order and limit the overlay", () => {
  assert.deepEqual(
    topPendingTodos(state, 2).map(({ id }) => id),
    [2, 3],
  )
})

test("kanban columns match Todo, In Progress, In Review, and Done", () => {
  const withReview: TodoState = {
    ...state,
    nextId: 7,
    todos: [
      ...state.todos,
      { id: 6, text: "Review release", status: "in_review" },
    ],
  }
  const columns = kanbanColumns(withReview)
  assert.deepEqual(
    columns.todo.map(({ id }) => id),
    [2, 3, 4, 5],
  )
  assert.deepEqual(
    columns.inProgress.map(({ id }) => id),
    [],
  )
  assert.deepEqual(
    columns.inReview.map(({ id }) => id),
    [6],
  )
  assert.deepEqual(
    columns.done.map(({ id }) => id),
    [1],
  )
})

test("task HUD keeps one preview row and stays smaller than the prompt", () => {
  assert.deepEqual(taskHudLines(state, 100_000), [
    "TASKS  ·  3 active  ·  1 blocked  ·  /kanban",
    "[ ] 01  #2  Fix classifier",
    "+3 hidden  ·  1/5 complete",
  ])
  assert.equal(taskHudLines(state).length, 3)
})

const framedAt = (width: number): string[] =>
  frameTaskHud(taskHud(state, 100_000), width)

test("a session with nothing tracked reserves the same three HUD rows", () => {
  const idle = taskHud({ todos: [], nextId: 1 })
  assert.equal(idle.kind, "idle")

  const framed = frameTaskHud(idle, 64)
  assert.equal(framed.length, 3)
  assert.equal(
    framed.every((line) => visibleWidth(line) === 64),
    true,
  )
  assert.match(
    framed[0] as string,
    /^╭─ TASKS  ·  nothing tracked ─+ \/kanban ─╮$/,
  )
  assert.match(framed[1] as string, /^│  No active tasks +│$/)
})

test("the HUD occupies the same columns whether or not a session tracks work", () => {
  const idle = frameTaskHud(taskHud({ todos: [], nextId: 1 }), 64)
  const tracking = framedAt(64)

  for (const line of [...idle, ...tracking])
    assert.equal(visibleWidth(line), 64)
  const contentColumn = (line: string): number => line.search(/[^│╭╰╶╴─ ]/)
  assert.equal(
    contentColumn(idle[0] as string),
    contentColumn(tracking[0] as string),
  )
})

test("the HUD stays within three lines no matter how much work is tracked", () => {
  const swamped: TodoState = {
    nextId: 61,
    todos: Array.from({ length: 60 }, (_unused, index) => ({
      id: index + 1,
      text: `Task ${index + 1}`,
      status: "pending" as const,
    })),
  }
  assert.equal(frameTaskHud(taskHud(swamped, 100_000), 64).length <= 3, true)
  assert.equal(taskHudLines(swamped, 100_000).length <= 3, true)
})

test("task HUD frame stays aligned without colored backgrounds or doubled corners", () => {
  const framed = framedAt(64)
  assert.equal(
    framed.every((line) => visibleWidth(line) === 64),
    true,
  )
  assert.match(
    framed[0] ?? "",
    /^╭─ TASKS  ·  3 active  ·  1 blocked ─+ \/kanban ─╮$/,
  )
  assert.match(framed[1] ?? "", /^│  \[ \] 01 {2}#2 {2}Fix classifier +│$/)
  assert.match(framed.at(-1) ?? "", /^╰─ \+3 hidden ─+ 1\/5 complete ─╯$/)
  assert.equal(
    framed.some((line) => /╾╮╯|╮╮|╯╯/.test(line)),
    false,
  )
})

test("every framed line opens its content in the same column", () => {
  const columnOf = (line: string): number => line.search(/[^│╭╰─ ]/)
  const columns = new Set(framedAt(64).map(columnOf))
  assert.deepEqual(
    [...columns],
    [3],
    "headline, rows, and footer must share one content column",
  )
})

const plain = (line: string): string => line.replaceAll(/\[[0-9;]*m/g, "")

test("labels never touch the border run that separates them", () => {
  for (const width of [40, 64, 120]) {
    // Drop the fixed corner gutters; the corners legitimately abut their own rule.
    const [headline, , footer] = framedAt(width).map((line) =>
      plain(line).slice(3, -3),
    ) as [string, string, string]
    assert.doesNotMatch(
      headline,
      /[^ ─]─|─[^ ─]/,
      `headline at width ${width} crams a label against its rule`,
    )
    assert.doesNotMatch(
      footer,
      /[^ ─]─|─[^ ─]/,
      `footer at width ${width} crams a label against its rule`,
    )
  }
})

test("overlong task text is elided rather than cut mid-word without a marker", () => {
  const long: TodoState = {
    nextId: 2,
    todos: [
      {
        id: 1,
        text: "Unstick the Yielduck context-overflow loop and stop verbose amplification",
        status: "pending",
      },
    ],
  }
  const row = frameTaskHud(taskHud(long, 100_000), 44)[1] as string
  assert.equal(visibleWidth(row), 44)
  assert.match(row, /…/)
})

test("the frame survives widths too narrow to hold its labels", () => {
  for (const width of [0, 6, 8, 12]) {
    const framed = frameTaskHud(taskHud(state, 100_000), width)
    assert.equal(
      framed.every(
        (line) => visibleWidth(line) === Math.max(width, GUTTER_FLOOR),
      ),
      true,
      `width ${width} produced a ragged frame`,
    )
  }
})

/** Below this the two 3-column gutters alone fill the line; the frame cannot shrink further. */
const GUTTER_FLOOR = 6

test("completed and cancelled tasks remain visible briefly before dropping from the HUD", () => {
  const settling: TodoState = {
    nextId: 4,
    todos: [
      { id: 1, text: "Done", status: "completed", statusChangedAt: 5_000 },
      { id: 2, text: "Cancelled", status: "cancelled", statusChangedAt: 6_000 },
      { id: 3, text: "Next", status: "pending" },
    ],
  }
  assert.deepEqual(taskHudLines(settling, 7_000).slice(1, 3), [
    "[-] 01  #2  Cancelled",
    "+2 hidden  ·  1/3 complete",
  ])
  assert.equal(taskHudLines(settling, 20_000)[1], "[ ] 01  #3  Next")
  assert.equal(
    taskHudLines(settling, 20_000).some((line) => line.includes("Cancelled")),
    false,
  )
})

test("task widget lines show compact top active tasks", () => {
  assert.deepEqual(taskWidgetLines(state, 2), [
    "Tasks: 1/5 done · 3 active · 1 blocked · /kanban",
    "[ ] #2 Fix classifier",
    "[ ] #3 Add task overlay",
    "… 1 more active task(s)",
    "[!] #5 Ship release — blocked: Waiting for production access",
  ])
})

test("empty task widget stays hidden", () => {
  assert.deepEqual(taskWidgetLines({ todos: [], nextId: 1 }), [])
})
