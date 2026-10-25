import assert from "node:assert/strict"
import test from "node:test"
import { Effect, Either, Option } from "effect"
import { decodeTodoControl } from "./control.ts"
import {
  decodeTodoState,
  parseTodoAction,
  transitionTodoState,
  wakeDueDeferredTodos,
  type TodoState,
} from "./state.ts"

const seed: TodoState = {
  nextId: 3,
  todos: [
    {
      id: 1,
      text: "Implement delivery unit",
      status: "in_progress",
      priority: 7,
      replies: ["Verified requirements"],
      statusChangedAt: 100,
    },
    {
      id: 2,
      text: "Check integration",
      parentId: 1,
      status: "blocked",
      reason: "Awaiting evidence",
      priority: 9,
    },
  ],
}
const apply = (state: TodoState, request: unknown) => {
  const decoded = decodeTodoControl(request)
  assert.ok(
    Either.isRight(decoded),
    "request must pass the shared manager/worker boundary",
  )
  const action = Effect.runSync(parseTodoAction(decoded.right, 1000))
  return Effect.runSync(transitionTodoState(state, action, 1000))
}

test("positive safe Fibonacci effort points can be set, edited, and cleared without changing task state", () => {
  for (const effort of [1, 2, 3, 5, 8, 13, 21, 34, 89, 8944394323791464]) {
    const estimated = apply(seed, { action: "effort", id: 2, effort }).state
    assert.deepEqual(estimated.todos, [
      seed.todos[0],
      { ...seed.todos[1], effort },
    ])
    assert.equal(estimated.nextId, seed.nextId)
    const edited = apply(estimated, {
      action: "effort",
      id: 2,
      effort: 5,
    }).state
    assert.deepEqual(edited.todos[1], { ...seed.todos[1], effort: 5 })
    assert.deepEqual(
      apply(edited, { action: "effort", id: 2, effort: null }).state,
      seed,
    )
  }
})

test("effort input rejects malformed points rather than treating them as time or coercing them", () => {
  for (const effort of [
    0,
    -1,
    4,
    6,
    2.5,
    Number.NaN,
    Infinity,
    Number.MAX_SAFE_INTEGER,
    "3",
    undefined,
    {},
    [],
  ]) {
    assert.ok(
      Either.isLeft(decodeTodoControl({ action: "effort", id: 1, effort })),
    )
  }
})

test("new estimated tasks and historical unestimated tasks round-trip without data loss", () => {
  const added = apply(seed, {
    action: "add",
    text: "Verify published unit",
    parentId: 1,
    effort: 3,
  }).state
  assert.deepEqual(added.todos.at(-1), {
    id: 3,
    text: "Verify published unit",
    parentId: 1,
    status: "pending",
    effort: 3,
  })
  const decoded = decodeTodoState(added)
  assert.ok(Option.isSome(decoded))
  assert.deepEqual(decoded.value, added)
  assert.deepEqual(decodeTodoState(seed), Option.some(seed))
  assert.ok(
    Option.isNone(
      decodeTodoState({
        nextId: 2,
        todos: [
          {
            id: 1,
            text: "Malformed persisted estimate",
            status: "pending",
            effort: 4,
          },
        ],
      }),
    ),
  )
})

test("effort remains advisory across priority, replies, status, blocking, and deferral", () => {
  let state = apply(seed, { action: "effort", id: 1, effort: 3 }).state
  for (const request of [
    { action: "priority", id: 1, priority: 1 },
    { action: "reply", id: 1, text: "Checks verified" },
    {
      action: "status",
      id: 1,
      status: "deferred",
      remindAt: "2030-01-01T00:00:00Z",
    },
    { action: "block", id: 1, reason: "Awaiting owner input" },
    { action: "unblock", id: 1 },
    { action: "toggle", id: 1 },
  ]) {
    state = apply(state, request).state
    const serialized = decodeTodoState(state)
    assert.ok(Option.isSome(serialized))
    const item = serialized.value.todos[0]
    assert.ok(item)
    assert.equal("effort" in item ? item.effort : undefined, 3)
  }
  assert.deepEqual(
    apply(seed, { action: "priority", id: 1, priority: 1 }).state.todos[1],
    seed.todos[1],
  )
})

test("every status, completed toggle, and due reminder preserves effort independently", () => {
  const estimated = apply(seed, { action: "effort", id: 1, effort: 3 }).state
  for (const status of [
    "pending",
    "in_progress",
    "in_review",
    "completed",
    "cancelled",
  ] as const) {
    const changed = apply(estimated, { action: "status", id: 1, status }).state
    assert.equal(changed.todos[0]?.status, status)
    assert.equal(changed.todos[0]?.effort, 3)
    assert.deepEqual(changed.todos[1], estimated.todos[1])
  }
  const completed = apply(estimated, {
    action: "status",
    id: 1,
    status: "completed",
  }).state
  const pending = apply(completed, { action: "toggle", id: 1 }).state
  assert.equal(pending.todos[0]?.status, "pending")
  assert.equal(pending.todos[0]?.effort, 3)
  const remindAt = "2030-01-01T00:00:00Z"
  const deferred = apply(estimated, {
    action: "status",
    id: 1,
    status: "deferred",
    remindAt,
  }).state
  const woken = wakeDueDeferredTodos(deferred, Date.parse(remindAt))
  assert.deepEqual(
    woken.woken.map(todo => todo.id),
    [1],
  )
  assert.equal(woken.state.todos[0]?.status, "pending")
  assert.equal(woken.state.todos[0]?.effort, 3)
  assert.deepEqual(woken.state.todos[1], estimated.todos[1])
})

test("shared task-list formatting displays relative effort points", () => {
  const state = apply(seed, { action: "effort", id: 1, effort: 3 }).state
  const listed = apply(state, { action: "list" })
  assert.match(listed.message, /\[effort 3 points\]/u)
  assert.match(listed.message, /\[priority 7\]/u)
})
