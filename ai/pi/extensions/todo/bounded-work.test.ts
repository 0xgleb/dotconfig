import assert from "node:assert/strict"
import { Effect, Either, Option } from "effect"
import test from "node:test"
import {
  decodeTodoState,
  emptyTodoState,
  parseTodoAction,
  transitionTodoState,
  validateTodoState,
  type TodoState,
} from "./state.ts"

import { branchTodoBacklogSnapshot } from "./backlog-adapter.ts"

const root: TodoState = {
  todos: [{ id: 1, text: "Publish the cleanup", status: "pending" }],
  nextId: 2,
}

test("fourth reply requires restructuring without mutating the blocker or history", () => {
  const state: TodoState = {
    todos: [
      {
        id: 1,
        text: "Publish",
        status: "blocked",
        reason: "Remote unavailable",
        replies: ["one", "two", "three"],
      },
    ],
    nextId: 2,
  }
  const result = Effect.runSync(
    Effect.either(
      transitionTodoState(state, { action: "reply", id: 1, text: "four" }),
    ),
  )
  assert.ok(Either.isLeft(result))
  assert.match(result.left.message, /restructur/i)
  assert.equal(state.todos[0].replies?.length, 3)
  assert.equal(state.todos[0].status, "blocked")
})

test("reply text is bounded at both parsing and the transition boundary", () => {
  const text = "x".repeat(301)
  assert.ok(
    Either.isLeft(
      Effect.runSync(
        Effect.either(parseTodoAction({ action: "reply", id: 1, text })),
      ),
    ),
  )
  assert.ok(
    Either.isLeft(
      Effect.runSync(
        Effect.either(
          transitionTodoState(root, { action: "reply", id: 1, text }),
        ),
      ),
    ),
  )
  assert.ok(
    Either.isRight(
      Effect.runSync(
        Effect.either(
          parseTodoAction({ action: "reply", id: 1, text: "x".repeat(300) }),
        ),
      ),
    ),
  )
})

test("root to subtask links survive status changes, blockers and reload decoding", () => {
  const created = Effect.runSync(
    transitionTodoState(root, {
      action: "add",
      text: "Verify remote",
      parentId: 1,
    }),
  ).state
  assert.equal(created.todos[1].parentId, 1)
  const blocked = Effect.runSync(
    transitionTodoState(created, { action: "block", id: 2, reason: "Offline" }),
  ).state
  assert.equal(blocked.todos[1].parentId, 1)
  const resumed = Effect.runSync(
    transitionTodoState(blocked, { action: "unblock", id: 2 }),
  ).state
  assert.equal(resumed.todos[1].parentId, 1)
  const completed = Effect.runSync(
    transitionTodoState(resumed, {
      action: "status",
      id: 2,
      status: "completed",
    }),
  ).state
  const decoded = decodeTodoState(JSON.parse(JSON.stringify(completed)))
  assert.ok(Option.isSome(decoded))
  assert.equal(decoded.value.todos[1].parentId, 1)
})

test("a subtask cannot be the parent of another task", () => {
  const child = Effect.runSync(
    transitionTodoState(root, { action: "add", text: "Child", parentId: 1 }),
  ).state
  const result = Effect.runSync(
    Effect.either(
      transitionTodoState(child, {
        action: "add",
        text: "Grandchild",
        parentId: 2,
      }),
    ),
  )
  assert.ok(Either.isLeft(result))
  assert.match(result.left.message, /subtask|one level/i)
})

test("missing, fractional and self parents are rejected without losing existing work", () => {
  for (const parentId of [99, 1.5, 2]) {
    const result = Effect.runSync(
      Effect.either(
        transitionTodoState(root, { action: "add", text: "Invalid", parentId }),
      ),
    )
    assert.ok(Either.isLeft(result))
    assert.deepEqual(
      root.todos.map(todo => todo.id),
      [1],
    )
  }
})

test("malformed persisted graphs fail through the typed boundary", () => {
  for (const state of [
    {
      todos: [{ id: 1, text: "Orphan", status: "pending", parentId: 99 }],
      nextId: 2,
    },
    {
      todos: [{ id: 1, text: "Self", status: "pending", parentId: 1 }],
      nextId: 2,
    },
    {
      todos: [
        { id: 1, text: "Root", status: "pending" },
        { id: 2, text: "Child", status: "pending", parentId: 1 },
        { id: 3, text: "Grandchild", status: "pending", parentId: 2 },
      ],
      nextId: 4,
    },
    {
      todos: [
        { id: 1, text: "Duplicate", status: "pending" },
        { id: 1, text: "Duplicate", status: "pending" },
      ],
      nextId: 2,
    },
  ]) {
    const decoded = decodeTodoState(state)
    assert.ok(Option.isSome(decoded))
    assert.ok(
      Either.isLeft(
        Effect.runSync(Effect.either(validateTodoState(decoded.value))),
      ),
    )
  }
})

test("list and backlog carry the root link without losing the blocker", () => {
  const child = Effect.runSync(
    transitionTodoState(root, {
      action: "add",
      text: "Verify remote",
      parentId: 1,
    }),
  ).state
  const state = Effect.runSync(
    transitionTodoState(child, { action: "block", id: 2, reason: "Offline" }),
  ).state
  const listed = Effect.runSync(transitionTodoState(state, { action: "list" }))
  assert.match(listed.message, /#2 \(subtask of #1\)/)
  const backlog = branchTodoBacklogSnapshot("/project", "session", state, 1)
  assert.ok(
    backlog.todos.some(
      todo =>
        todo.requirements.includes("Subtask of root todo #1") &&
        todo.requirements.includes("Current blocker: Offline"),
    ),
  )
})

test("legacy reply history remains readable rather than being silently truncated", () => {
  const state: TodoState = {
    todos: [
      {
        id: 1,
        text: "Legacy",
        status: "pending",
        replies: ["one", "two", "three", "four"],
      },
    ],
    nextId: 2,
  }
  const decoded = decodeTodoState(state)
  assert.ok(Option.isSome(decoded))
  assert.deepEqual(decoded.value.todos[0].replies, state.todos[0].replies)
  assert.ok(
    Either.isLeft(
      Effect.runSync(
        Effect.either(
          transitionTodoState(state, { action: "reply", id: 1, text: "five" }),
        ),
      ),
    ),
  )
})
