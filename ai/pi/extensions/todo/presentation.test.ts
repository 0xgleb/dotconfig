import assert from "node:assert/strict";
import test from "node:test";
import { kanbanColumns, taskWidgetLines, todoSummary, topPendingTodos } from "./presentation.ts";
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
  assert.deepEqual(todoSummary(state), { total: 5, completed: 1, pending: 3, blocked: 1 });
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
