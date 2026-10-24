import assert from "node:assert/strict"
import test from "node:test"
import { visibleWidth } from "@earendil-works/pi-tui"
import {
  frameTaskHud,
  kanbanColumns,
  shouldShowTaskHud,
  taskCompletionPercent,
  taskHud,
  taskHudLines,
  taskProgressActiveStep,
  taskProgressBar,
  taskProgressCellPulse,
  taskProgressDisplayedCell,
  taskProgressIdlePulse,
  type TaskProgressCell,
  taskWidgetLines,
  todoSummary,
  toggleTaskHudVisibility,
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

test("completion percentage is bounded and defined for an empty board", () => {
  assert.equal(taskCompletionPercent(1, 5), 20)
  assert.equal(taskCompletionPercent(0, 0), 0)
  assert.equal(taskCompletionPercent(8, 5), 100)
})

test("active progress pulses once per completed cell, then all once", () => {
  const bar = "▰▰▱▱" as const
  const displayed = (frame: number) =>
    [...bar]
      .map((cell, index) =>
        taskProgressDisplayedCell(
          cell as TaskProgressCell,
          frame,
          index,
          2,
          false,
        ),
      )
      .join("")
  const pulses = (frame: number) =>
    [...bar].map((cell, index) =>
      taskProgressCellPulse(cell as TaskProgressCell, frame, index, 2, false),
    )

  assert.deepEqual(
    Array.from({ length: 7 }, (_, frame) => displayed(frame)),
    Array.from({ length: 7 }, () => "▰▰▱▱"),
    "active work never turns completed cells off",
  )
  assert.deepEqual(
    Array.from({ length: 7 }, (_, frame) => pulses(frame)),
    [
      [true, false, false, false],
      [false, false, false, false],
      [false, true, false, false],
      [false, false, false, false],
      [true, true, false, false],
      [false, false, false, false],
      [true, false, false, false],
    ],
  )
  assert.deepEqual(taskProgressActiveStep(0, 2), {
    scope: "cell",
    cellIndex: 0,
    pulse: true,
  })
  assert.deepEqual(taskProgressActiveStep(1, 2), {
    scope: "cell",
    cellIndex: 0,
    pulse: false,
  })
  assert.deepEqual(taskProgressActiveStep(2, 2), {
    scope: "cell",
    cellIndex: 1,
    pulse: true,
  })
  assert.deepEqual(taskProgressActiveStep(4, 2), {
    scope: "all",
    pulse: true,
  })
  assert.deepEqual(taskProgressActiveStep(5, 2), {
    scope: "all",
    pulse: false,
  })
  assert.deepEqual(taskProgressActiveStep(6, 2), {
    scope: "cell",
    cellIndex: 0,
    pulse: true,
  })
  assert.equal(taskProgressActiveStep(6, 0), undefined)
  assert.equal(taskProgressBar(0, 5), "▱▱▱▱▱▱▱▱")
  assert.equal(visibleWidth(bar), 4)
})

test("one completed cell preserves one positive cell and all-region pulse", () => {
  assert.deepEqual(
    Array.from({ length: 5 }, (_, frame) => taskProgressActiveStep(frame, 1)),
    [
      { scope: "cell", cellIndex: 0, pulse: true },
      { scope: "cell", cellIndex: 0, pulse: false },
      { scope: "all", pulse: true },
      { scope: "all", pulse: false },
      { scope: "cell", cellIndex: 0, pulse: true },
    ],
  )
})

test("idle progress starts with the whole completed region off, then on", () => {
  const bar = "▰▰▰▱▱" as const
  const displayed = (frame: number) =>
    [...bar]
      .map((cell, index) =>
        taskProgressDisplayedCell(
          cell as TaskProgressCell,
          frame,
          index,
          3,
          true,
        ),
      )
      .join("")

  // Logical frames are sampled every 500ms in idle mode; three equal frames
  // keep idle noticeably slower without the prior two-second hold.
  assert.deepEqual(
    Array.from({ length: 8 }, (_, frame) => taskProgressIdlePulse(frame)),
    [false, false, false, true, true, true, false, false],
  )
  assert.deepEqual(
    Array.from({ length: 8 }, (_, frame) => displayed(frame)),
    ["▱▱▱▱▱", "▱▱▱▱▱", "▱▱▱▱▱", "▰▰▰▱▱", "▰▰▰▱▱", "▰▰▰▱▱", "▱▱▱▱▱", "▱▱▱▱▱"],
  )
})

test("task progress uses one glyph family so no cell protrudes from the row", () => {
  assert.equal(taskProgressBar(1, 8), "▰▱▱▱▱▱▱▱")
  assert.equal(taskProgressBar(1, 5), "▰▰▱▱▱▱▱▱")
  assert.equal(taskProgressBar(1, 3), "▰▰▰▱▱▱▱▱")
  assert.equal(taskProgressBar(7, 8), "▰▰▰▰▰▰▰▱")
  assert.equal(taskProgressBar(8, 8), "▰▰▰▰▰▰▰▰")
  assert.equal(taskProgressBar(1, 4, 16), "▰▰▰▰▱▱▱▱▱▱▱▱▱▱▱▱")
  assert.equal(taskProgressBar(1, 4, -10), "▰▰▱▱▱▱▱▱")
  assert.equal(taskProgressBar(1, 4, Number.NaN), "▰▰▱▱▱▱▱▱")
  assert.equal(taskProgressBar(1, 4, Number.POSITIVE_INFINITY), "▰▰▱▱▱▱▱▱")
  assert.match(taskProgressBar(1, 4, 1_000), /^[▰▱]{32}$/u)
  for (let completed = 0; completed <= 17; completed++) {
    assert.match(taskProgressBar(completed, 17), /^[▰▱]{8}$/u)
    assert.match(taskProgressBar(completed, 17, 32), /^[▰▱]{32}$/u)
  }
})

test("task progress grows only when the pane has spare headline capacity", () => {
  const progressWidth = (width: number): number => {
    const hud = taskHud(state, 100_000, width)
    assert.equal(hud.kind, "tracking")
    return hud.headline.right.match(/[▰▱]+/u)?.[0]?.length ?? 0
  }

  assert.equal(progressWidth(64), 8)
  assert.ok(progressWidth(80) > 8)
  assert.equal(progressWidth(120), 32)
  for (const width of [64, 80, 120])
    assert.equal(
      frameTaskHud(taskHud(state, 100_000, width), width).every(
        line => visibleWidth(line) === width,
      ),
      true,
    )
})

test("task HUD keeps one preview row and a compact progress bar", () => {
  assert.equal(taskProgressBar(1, 5), "▰▰▱▱▱▱▱▱")
  assert.deepEqual(taskHudLines(state, 100_000), [
    "TASKS  ·  3 active  ·  1 blocked  ·  ▰▰▱▱▱▱▱▱  20%  ·  /kanban",
    "[ ] 01  #2  Fix classifier",
  ])
  assert.equal(taskHudLines(state).length, 2)
})

const framedAt = (width: number): string[] =>
  frameTaskHud(taskHud(state, 100_000), width)

test("a session with nothing tracked reserves the same two shared-border rows", () => {
  const idle = taskHud({ todos: [], nextId: 1 })
  assert.equal(idle.kind, "idle")

  const framed = frameTaskHud(idle, 64)
  assert.equal(framed.length, 2)
  assert.equal(
    framed.every(line => visibleWidth(line) === 64),
    true,
  )
  assert.match(
    (framed[0] as string).trim(),
    /^╭─ TASKS  ·  nothing tracked ─+ \/kanban ─╮$/,
  )
  assert.match((framed[1] as string).trim(), /^│  No active tasks +│$/)
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

test("the HUD stays within two lines no matter how much work is tracked", () => {
  const swamped: TodoState = {
    nextId: 61,
    todos: Array.from({ length: 60 }, (_unused, index) => ({
      id: index + 1,
      text: `Task ${index + 1}`,
      status: "pending" as const,
    })),
  }
  assert.equal(frameTaskHud(taskHud(swamped, 100_000), 64).length <= 2, true)
  assert.equal(taskHudLines(swamped, 100_000).length <= 2, true)
})

test("task HUD frame stays aligned without colored backgrounds or doubled corners", () => {
  const framed = framedAt(64)
  assert.equal(
    framed.every(line => visibleWidth(line) === 64),
    true,
  )
  assert.match(
    (framed[0] ?? "").trim(),
    /^╭─ TASKS.*▰▰▱▱▱▱▱▱  20%  ·  \/kanban ─╮$/,
  )
  assert.match(
    (framed[1] ?? "").trim(),
    /^│  \[ \] 01 {2}#2 {2}Fix classifier +│$/,
  )
  assert.equal(
    framed.some(line => /╾╮╯|╮╮|╯╯/.test(line)),
    false,
  )
})

test("every framed line opens its content in the same column", () => {
  const columnOf = (line: string): number => line.search(/[^│╭╰─ ]/)
  const columns = new Set(framedAt(64).map(columnOf))
  assert.deepEqual(
    [...columns],
    [3],
    "headline and row must share one content column",
  )
})

const plain = (line: string): string => line.replaceAll(/\[[0-9;]*m/g, "")

test("labels never touch the border run that separates them", () => {
  for (const width of [40, 64, 120]) {
    // Drop the fixed corner gutters; the corners legitimately abut their own rule.
    const [headline] = framedAt(width).map(line =>
      plain(line).trim().slice(3, -3),
    )
    assert.doesNotMatch(
      headline,
      /[^ ─]─|─[^ ─]/,
      `headline at width ${width} crams a label against its rule`,
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
        line => visibleWidth(line) === Math.max(width, GUTTER_FLOOR),
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
  assert.deepEqual(taskHudLines(settling, 7_000).slice(1), [
    "[-] 01  #2  Cancelled",
  ])
  assert.equal(taskHudLines(settling, 20_000)[1], "[ ] 01  #3  Next")
  assert.equal(
    taskHudLines(settling, 20_000).some(line => line.includes("Cancelled")),
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

test("toggling task HUD visibility flips between visible and hidden", () => {
  assert.equal(toggleTaskHudVisibility("visible"), "hidden")
  assert.equal(toggleTaskHudVisibility("hidden"), "visible")
})

test("task HUD shows only when tracking work and not manually hidden", () => {
  const tracking = todoSummary(state)

  assert.equal(shouldShowTaskHud(tracking, "visible"), true)
  assert.equal(shouldShowTaskHud(tracking, "hidden"), false)
})

test("an empty board never shows the HUD regardless of the toggle", () => {
  const empty = todoSummary({ todos: [], nextId: 1 })

  assert.equal(shouldShowTaskHud(empty, "visible"), false)
  assert.equal(shouldShowTaskHud(empty, "hidden"), false)
})
