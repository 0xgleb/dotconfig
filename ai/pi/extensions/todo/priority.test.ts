import assert from "node:assert/strict"
import test from "node:test"
import { Effect, Either, Option } from "effect"
import {
  decodeTodoState,
  parseTodoAction,
  transitionTodoState,
  validateTodoState,
  wakeDueDeferredTodos,
  type TodoState,
  type TodoAction,
} from "./state.ts"

const initial: TodoState = {
  todos: [
    {
      id: 1,
      text: "Held parent",
      status: "blocked",
      reason: "owner pause",
      replies: ["preserve scope"],
    },
    {
      id: 2,
      parentId: 1,
      text: "Target",
      status: "deferred",
      remindAt: 9000,
      statusChangedAt: 123,
    },
  ],
  nextId: 3,
}

const run = Effect.runSync

test("priority-only correction persists/read-backs without changing status, hold, schedule or IDs", () => {
  const before = JSON.stringify(initial)

  const action = run(
    parseTodoAction({ action: "priority", id: 2, priority: 1 }),
  )
  const result = run(transitionTodoState(initial, action, 5000))

  assert.deepEqual(result.state, {
    ...initial,
    todos: [initial.todos[0], { ...initial.todos[1], priority: 1 }],
  })
  assert.equal(JSON.stringify(initial), before)

  const restored = decodeTodoState(JSON.parse(JSON.stringify(result.state)))

  assert.ok(Option.isSome(restored))
  if (Option.isSome(restored)) assert.deepEqual(restored.value, result.state)

  assert.match(
    run(transitionTodoState(result.state, { action: "list" })).message,
    /priority 1/,
  )
})

test("explicit null removes priority without inventing a replacement rank", () => {
  const state: TodoState = {
    ...initial,
    todos: [initial.todos[0]!, { ...initial.todos[1]!, priority: 3 }],
  }

  const result = run(
    transitionTodoState(
      state,
      run(parseTodoAction({ action: "priority", id: 2, priority: null })),
    ),
  )

  assert.deepEqual(result.state, initial)
  assert.equal("priority" in result.state.todos[1]!, false)
})

test("priority input rejects absent, nonpositive, fractional and unsafe ranks with typed failures", () => {
  for (const priority of [
    undefined,
    0,
    -1,
    1.1,
    Number.MAX_SAFE_INTEGER + 1,
    Infinity,
    NaN,
  ]) {
    const result = run(
      Effect.either(
        parseTodoAction({
          action: "priority",
          id: 2,
          ...(priority === undefined ? {} : { priority }),
        }),
      ),
    )

    assert.ok(Either.isLeft(result))
    if (Either.isLeft(result))
      assert.equal(result.left.code, "invalid_priority")
  }
})

test("malformed persisted priority is rejected, never silently decoded as unassigned", () => {
  for (const priority of [0, -1, 1.5, Infinity, NaN, "1", null]) {
    assert.equal(
      Option.isNone(
        decodeTodoState({
          ...initial,
          todos: [{ ...initial.todos[0], priority }],
        }),
      ),
      true,
      String(priority),
    )
  }

  const result = run(
    Effect.either(
      validateTodoState({
        ...initial,
        todos: [{ ...initial.todos[0]!, priority: 0 }],
      }),
    ),
  )

  assert.ok(Either.isLeft(result))
  if (Either.isLeft(result)) assert.equal(result.left.code, "invalid_priority")
})

test("nonterminal status/block/wake transitions preserve rank while terminal transitions release it", () => {
  const state: TodoState = {
    todos: [{ id: 1, text: "Ranked", status: "pending", priority: 3 }],
    nextId: 2,
  }

  for (const action of [
    { action: "toggle", id: 1 },
    { action: "toggle", id: 1 },
    { action: "status", id: 1, status: "in_progress" },
    { action: "status", id: 1, status: "in_review" },
    { action: "status", id: 1, status: "cancelled" },
    { action: "block", id: 1, reason: "hold" },
    { action: "unblock", id: 1 },
    { action: "reply", id: 1, text: "evidence" },
    { action: "status", id: 1, status: "deferred", remindAt: 9000 },
  ] satisfies TodoAction[]) {
    const after = run(transitionTodoState(state, action, 1000)).state
    const finishes =
      action.action === "toggle" ||
      (action.action === "status" && action.status === "cancelled")

    assert.equal(
      after.todos[0]?.priority,
      finishes ? undefined : 3,
      action.action,
    )
  }

  const deferred = run(
    transitionTodoState(state, {
      action: "status",
      id: 1,
      status: "deferred",
      remindAt: 9000,
    }),
  ).state

  assert.equal(wakeDueDeferredTodos(deferred, 9000).state.todos[0]?.priority, 3)
})

test("missing priority target and bypassed invalid domain action fail without mutating state", () => {
  const missing = run(
    Effect.either(
      transitionTodoState(initial, { action: "priority", id: 99, priority: 1 }),
    ),
  )

  assert.ok(Either.isLeft(missing))
  if (Either.isLeft(missing))
    assert.equal(missing.left._tag, "TodoNotFoundError")

  const invalid = run(
    Effect.either(
      transitionTodoState(initial, { action: "priority", id: 2, priority: 0 }),
    ),
  )

  assert.ok(Either.isLeft(invalid))
  if (Either.isLeft(invalid)) {
    assert.equal(invalid.left._tag, "TodoInputError")
    if (invalid.left._tag === "TodoInputError")
      assert.equal(invalid.left.code, "invalid_priority")
  }
})
