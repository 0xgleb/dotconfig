import assert from "node:assert/strict"
import test from "node:test"
import { Either } from "effect"
import { todoWorkSnapshot } from "./goal.ts"
import {
  managerObservation,
  parseManagerPriorities,
  MANAGER_PRIORITY_ENTRY,
} from "./manager-core.ts"
import type { Todo, TodoState } from "../todo/state.ts"

const entries = (todos: readonly Todo[], order?: readonly number[]) => [
  {
    type: "custom",
    customType: "todo.state",
    data: { todos, nextId: todos.length + 1 } satisfies TodoState,
  },
  ...(order === undefined
    ? []
    : [
        {
          type: "custom",
          customType: MANAGER_PRIORITY_ENTRY,
          data: { version: 1, ids: order },
        },
      ]),
]
const ids = (lines: readonly string[]) => lines.map(line => line.split(" ")[0])

test("continuation ranks assigned worker priority before unassigned work without rewriting committed order", () => {
  const todos: Todo[] = [
    { id: 1, text: "Later", status: "pending", priority: 3 },
    { id: 2, text: "First", status: "pending", priority: 1 },
    { id: 3, text: "Unassigned", status: "in_progress" },
  ]
  const branch = entries(todos, [1, 3, 2])
  const before = JSON.stringify(branch)
  assert.deepEqual(ids(todoWorkSnapshot(branch).pending), ["#2", "#1", "#3"])
  assert.equal(JSON.stringify(branch), before)
})

test("equal ranks retain committed tie order and unassigned legacy work retains its existing behavior", () => {
  const ranked: Todo[] = [
    { id: 1, text: "A", status: "pending", priority: 1 },
    { id: 2, text: "B", status: "pending", priority: 1 },
  ]
  assert.deepEqual(ids(todoWorkSnapshot(entries(ranked, [2, 1])).pending), [
    "#2",
    "#1",
  ])
  const legacy: Todo[] = [
    { id: 1, text: "A", status: "pending" },
    { id: 2, text: "B", status: "in_progress" },
  ]
  assert.deepEqual(ids(todoWorkSnapshot(entries(legacy)).pending), ["#2", "#1"])
})

test("rank cannot make a child of a held parent runnable or selectable", () => {
  for (const parent of [
    { id: 1, text: "Root", status: "blocked", reason: "owner pause" },
    { id: 1, text: "Root", status: "deferred" },
  ] satisfies Todo[]) {
    const todos: Todo[] = [
      parent,
      {
        id: 2,
        text: "Held child",
        parentId: 1,
        status: "pending",
        priority: 1,
      },
      { id: 3, text: "Runnable", status: "pending", priority: 2 },
    ]
    const before = JSON.stringify(todos)
    const snapshot = todoWorkSnapshot(entries(todos))
    assert.deepEqual(ids(snapshot.pending), ["#3"])
    assert.ok(
      snapshot.blocked.some(
        text => text.startsWith("#2 ") && text.includes("parent"),
      ),
    )
    assert.ok(Either.isLeft(parseManagerPriorities("2", todos)))
    assert.equal(JSON.stringify(todos), before)
  }
})

test("present malformed rank blocks projection instead of silently becoming unassigned", () => {
  for (const priority of [0, -1, 1.5, NaN, Infinity, null, "1", undefined]) {
    const state = {
      todos: [{ id: 1, text: "Unsafe rank", status: "pending", priority }],
      nextId: 2,
    }
    for (const latest of [
      { type: "custom", customType: "todo.state", data: state },
      {
        type: "message",
        message: { role: "toolResult", toolName: "todo", details: { state } },
      },
    ]) {
      const projected = todoWorkSnapshot([
        ...entries([{ id: 1, text: "Older state", status: "pending" }]),
        latest,
      ])
      assert.deepEqual(projected.pending, [])
      assert.match(projected.blocked.join(" "), /priority/i)
    }
  }
})

test("manager observation exposes actual priority metadata without treating blocked work as runnable", () => {
  const observation = managerObservation([
    { id: 1, text: "Low", status: "pending", priority: 5 },
    {
      id: 2,
      text: "Important but held",
      status: "blocked",
      reason: "wait",
      priority: 1,
    },
  ])
  assert.deepEqual(
    observation.tasks.map(task => task.id),
    [2, 1],
  )
  assert.deepEqual(observation.tasks[0], {
    id: 2,
    title: "Important but held",
    status: "blocked",
    priority: 1,
  })
})
