import assert from "node:assert/strict";
import test from "node:test";
import {
  frameTaskHudLines,
  kanbanColumns,
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
    "TASK//GRID  3 ACTIVE · 1 BLOCKED  /kanban",
    "☐ 01  #2  Fix classifier",
    "☐ 02  #3  Add task overlay",
    "+2 HIDDEN  1/5 COMPLETE",
  ]);
  assert.equal(taskHudLines(state).length <= 4, true);
});

test("task HUD frame stays aligned without colored backgrounds or doubled corners", () => {
  const framed = frameTaskHudLines(taskHudLines(state, 100_000), 64);
  assert.equal(framed.every((line) => line.length === 64), true);
  assert.match(framed[0] ?? "", /^╭─ TASK\/\/GRID.*╮$/);
  assert.match(framed[1] ?? "", /^│ ☐ 01.*│$/);
  assert.match(framed.at(-1) ?? "", /^╰─ \+2 HIDDEN.*╯$/);
  assert.equal(framed.some((line) => /╾╮╯|╮╮|╯╯/.test(line)), false);
});

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
    ["⊘ 01  #2  Cancelled", "☑ 02  #1  Done"],
  );
  assert.equal(taskHudLines(settling, 20_000)[1], "☐ 01  #3  Next");
  assert.equal(taskHudLines(settling, 20_000).some((line) => line.includes("Cancelled")), false);
});

test("task widget lines show compact top active tasks", () => {
  assert.deepEqual(taskWidgetLines(state, 2), [
    "Tasks: 1/5 done · 3 active · 1 blocked · /kanban",
    "○ #2 Fix classifier",
    "○ #3 Add task overlay",
    "… 1 more active task(s)",
    "⊘ #5 Ship release — blocked: Waiting for production access",
  ]);
});

test("empty task widget stays hidden", () => {
  assert.deepEqual(taskWidgetLines({ todos: [], nextId: 1 }), []);
});
