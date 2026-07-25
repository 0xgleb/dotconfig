import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
  frameTaskHud,
  kanbanColumns,
  taskHud,
  taskHudLines,
  taskWidgetLines,
  todoSummary,
  topPendingTodos,
} from "./presentation.ts";
import type { TodoState } from "./state.ts";

const state: TodoState = {
  nextId: 6,
  todos: [
    { id: 1, text: "Inspect handover", status: "completed" },
    { id: 2, text: "Fix classifier", status: "pending" },
    { id: 3, text: "Add task overlay", status: "pending" },
    { id: 4, text: "Run smoke tests", status: "pending" },
    { id: 5, text: "Ship release", status: "blocked", reason: "Waiting for production access" },
  ],
};

test("todo summary counts pending, blocked, and completed tasks", () => {
  assert.deepEqual(todoSummary(state), {
    total: 5,
    completed: 1,
    pending: 3,
    inProgress: 0,
    blocked: 1,
    deferred: 0,
    cancelled: 0,
  });
});

test("top pending todos preserve task order and limit the overlay", () => {
  assert.deepEqual(
    topPendingTodos(state, 2).map(({ id }) => id),
    [2, 3],
  );
});

test("kanban columns separate current, queued, and completed work", () => {
  const columns = kanbanColumns(state);
  assert.deepEqual(columns.now.map(({ id }) => id), [2]);
  assert.deepEqual(columns.next.map(({ id }) => id), [3, 4, 5]);
  assert.deepEqual(columns.done.map(({ id }) => id), [1]);
});

test("task HUD keeps the visible queue archeofuturist and bounded to four lines", () => {
  assert.deepEqual(taskHudLines(state, 100_000), [
    "TASKS  ·  3 active  ·  1 blocked  ·  /kanban",
    "[ ] 01  #2  Fix classifier",
    "[ ] 02  #3  Add task overlay",
    "+2 hidden  ·  1/5 complete",
  ]);
  assert.equal(taskHudLines(state).length <= 4, true);
});

const framedAt = (width: number): string[] => frameTaskHud(taskHud(state, 100_000) as never, width);

test("task HUD frame stays aligned without colored backgrounds or doubled corners", () => {
  const framed = framedAt(64);
  assert.equal(framed.every((line) => visibleWidth(line) === 64), true);
  assert.match(framed[0] ?? "", /^╭─ TASKS  ·  3 active  ·  1 blocked ─+ \/kanban ─╮$/);
  assert.match(framed[1] ?? "", /^│  \[ \] 01 {2}#2 {2}Fix classifier +│$/);
  assert.match(framed.at(-1) ?? "", /^╰─ \+2 hidden ─+ 1\/5 complete ─╯$/);
  assert.equal(framed.some((line) => /╾╮╯|╮╮|╯╯/.test(line)), false);
});

test("every framed line opens its content in the same column", () => {
  const columnOf = (line: string): number => line.search(/[^│╭╰─ ]/);
  const columns = new Set(framedAt(64).map(columnOf));
  assert.deepEqual([...columns], [3], "headline, rows, and footer must share one content column");
});

const plain = (line: string): string => line.replaceAll(/\[[0-9;]*m/g, "");

test("labels never touch the border run that separates them", () => {
  for (const width of [40, 64, 120]) {
    // Drop the fixed corner gutters; the corners legitimately abut their own rule.
    const [headline, , , footer] = framedAt(width).map((line) => plain(line).slice(3, -3)) as [
      string,
      string,
      string,
      string,
    ];
    assert.doesNotMatch(headline, /[^ ─]─|─[^ ─]/, `headline at width ${width} crams a label against its rule`);
    assert.doesNotMatch(footer, /[^ ─]─|─[^ ─]/, `footer at width ${width} crams a label against its rule`);
  }
});

test("overlong task text is elided rather than cut mid-word without a marker", () => {
  const long: TodoState = {
    nextId: 2,
    todos: [{ id: 1, text: "Unstick the Yielduck context-overflow loop and stop verbose amplification", status: "pending" }],
  };
  const row = frameTaskHud(taskHud(long, 100_000) as never, 44)[1] as string;
  assert.equal(visibleWidth(row), 44);
  assert.match(row, /…/);
});

test("the frame survives widths too narrow to hold its labels", () => {
  for (const width of [0, 6, 8, 12]) {
    const framed = frameTaskHud(taskHud(state, 100_000) as never, width);
    assert.equal(
      framed.every((line) => visibleWidth(line) === Math.max(width, GUTTER_FLOOR)),
      true,
      `width ${width} produced a ragged frame`,
    );
  }
});

/** Below this the two 3-column gutters alone fill the line; the frame cannot shrink further. */
const GUTTER_FLOOR = 6;

test("completed and cancelled tasks remain visible briefly before dropping from the HUD", () => {
  const settling: TodoState = {
    nextId: 4,
    todos: [
      { id: 1, text: "Done", status: "completed", statusChangedAt: 5_000 },
      { id: 2, text: "Cancelled", status: "cancelled", statusChangedAt: 6_000 },
      { id: 3, text: "Next", status: "pending" },
    ],
  };
  assert.deepEqual(
    taskHudLines(settling, 7_000).slice(1, 3),
    ["[-] 01  #2  Cancelled", "[x] 02  #1  Done"],
  );
  assert.equal(taskHudLines(settling, 20_000)[1], "[ ] 01  #3  Next");
  assert.equal(taskHudLines(settling, 20_000).some((line) => line.includes("Cancelled")), false);
});

test("task widget lines show compact top active tasks", () => {
  assert.deepEqual(taskWidgetLines(state, 2), [
    "Tasks: 1/5 done · 3 active · 1 blocked · /kanban",
    "[ ] #2 Fix classifier",
    "[ ] #3 Add task overlay",
    "… 1 more active task(s)",
    "[!] #5 Ship release — blocked: Waiting for production access",
  ]);
});

test("empty task widget stays hidden", () => {
  assert.deepEqual(taskWidgetLines({ todos: [], nextId: 1 }), []);
});
