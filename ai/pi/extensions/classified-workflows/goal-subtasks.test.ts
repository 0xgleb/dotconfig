import assert from "node:assert/strict"
import test from "node:test"
import { todoWorkSnapshot, taskContinuationMessage } from "./goal.ts"

const snapshot = (todos: readonly unknown[]) =>
  todoWorkSnapshot([
    { type: "custom", customType: "todo.state", data: { todos } },
  ])

test("completed roots do not hide pending children or their root links", () => {
  const work = snapshot([
    { id: 1, text: "Cleanup", status: "completed" },
    { id: 2, parentId: 1, text: "Publish", status: "pending" },
    {
      id: 3,
      parentId: 1,
      text: "Verify runtime",
      status: "blocked",
      reason: "Reload pending",
    },
  ])
  assert.deepEqual(work.pending, ["#2 (subtask of #1) Publish"])
  assert.deepEqual(work.blocked, [
    "#3 (subtask of #1) Verify runtime — Reload pending",
  ])
  assert.match(taskContinuationMessage(work) ?? "", /subtask of #1/)
})

test("malformed parent links are explicit blockers, never trusted relationships", () => {
  for (const parentId of [0, -1, "1", 99, 2]) {
    const work = snapshot([
      { id: 1, text: "Root", status: "completed" },
      { id: 2, parentId, text: "Repair", status: "pending" },
    ])
    assert.deepEqual(work.pending, [])
    assert.match(work.blocked[0] ?? "", /#2 Repair.*invalid parent/i)
  }
  const work = snapshot([
    { id: 1, text: "Root", status: "pending" },
    { id: 2, parentId: 1, text: "Child", status: "pending" },
    { id: 3, parentId: 2, text: "Grandchild", status: "pending" },
  ])
  assert.match(work.blocked[0] ?? "", /#3 Grandchild.*invalid parent/i)
})

test("review work remains executable work rather than disappearing from continuation", () => {
  const work = snapshot([
    { id: 4, text: "Review before delivery", status: "in_review" },
  ])
  assert.deepEqual(work.pending, ["#4 Review before delivery"])
  assert.match(taskContinuationMessage(work) ?? "", /Review before delivery/)
})
