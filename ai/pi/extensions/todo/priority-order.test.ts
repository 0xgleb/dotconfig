import assert from "node:assert/strict"
import test from "node:test"
import { Effect, Either, Option } from "effect"
import { decodeTodoControl } from "./control.ts"
import {
  decodeTodoState,
  parseTodoAction,
  transitionTodoState,
  type TodoState,
} from "./state.ts"

const seed: TodoState = {
  nextId: 5,
  todos: [
    {
      id: 1,
      text: "Held parent",
      status: "blocked",
      reason: "Retain hold",
      replies: ["Scope retained"],
      priority: 2,
    },
    {
      id: 2,
      text: "Deferred child",
      parentId: 1,
      status: "deferred",
      remindAt: 9000,
      statusChangedAt: 123,
      priority: 8,
    },
    { id: 3, text: "Unranked work", status: "pending" },
    {
      id: 4,
      text: "Historical completion",
      status: "completed",
      priority: Number.MAX_SAFE_INTEGER,
    },
  ],
}

const apply = (state: TodoState, request: unknown) => {
  const decoded = decodeTodoControl(request)

  assert.ok(
    Either.isRight(decoded),
    "valid operation must pass shared worker/manager decoding",
  )

  return Effect.runSync(
    transitionTodoState(
      state,
      Effect.runSync(parseTodoAction(decoded.right)),
      1000,
    ),
  )
}

const expectRanks = (
  before: TodoState,
  after: TodoState,
  ranks: Record<number, number>,
) => {
  assert.equal(after.nextId, before.nextId)
  assert.deepEqual(
    after.todos,
    before.todos.map(todo =>
      ranks[todo.id] === undefined
        ? todo
        : { ...todo, priority: ranks[todo.id] },
    ),
  )

  const decoded = decodeTodoState(JSON.parse(JSON.stringify(after)))

  assert.ok(Option.isSome(decoded))
  assert.deepEqual(decoded.value, after)
}

test("relative above/below atomically orders ranks while preserving holds, history and effort", () => {
  const estimated = apply(seed, { action: "effort", id: 3, effort: 3 }).state
  const before = JSON.stringify(estimated)

  const above = apply(estimated, {
    action: "priority_relative",
    id: 3,
    referenceId: 2,
    position: "above",
  }).state

  expectRanks(estimated, above, { 1: 1, 3: 2, 2: 3 })

  const below = apply(above, {
    action: "priority_relative",
    id: 1,
    referenceId: 2,
    position: "below",
  }).state

  expectRanks(above, below, { 3: 1, 2: 2, 1: 3 })
  assert.equal(JSON.stringify(estimated), before)
})

test("one bulk order includes active assigned tasks and can assign unranked work without rewriting history", () => {
  const before = JSON.stringify(seed)

  const ordered = apply(seed, {
    action: "priority_order",
    ids: [2, 3, 1],
  }).state

  expectRanks(seed, ordered, { 2: 1, 3: 2, 1: 3 })
  assert.equal(JSON.stringify(seed), before)
})

test("absolute assignments reject occupied ranks, while explicit null still unassigns", () => {
  const collision = Effect.runSync(
    Effect.either(
      transitionTodoState(seed, { action: "priority", id: 3, priority: 2 }),
    ),
  )

  assert.ok(Either.isLeft(collision))
  assert.equal(collision.left._tag, "TodoInputError")
  if (collision.left._tag === "TodoInputError")
    assert.equal(collision.left.code, "priority_conflict")

  const unassigned = apply(seed, {
    action: "priority",
    id: 1,
    priority: null,
  }).state

  assert.equal("priority" in unassigned.todos[0]!, false)
  assert.deepEqual(unassigned.todos.slice(1), seed.todos.slice(1))
})

test("reapplying an existing rank is idempotent even for legacy active collisions", () => {
  const legacy: TodoState = {
    ...seed,
    todos: seed.todos.map(todo =>
      todo.id === 2 ? { ...todo, priority: 2 } : todo,
    ),
  }

  const result = apply(legacy, { action: "priority", id: 1, priority: 2 })

  assert.deepEqual(result.state, legacy)
})

test("historical terminal ranks do not occupy slots or need manual unranking", () => {
  for (const status of ["completed", "cancelled"] as const) {
    const legacy: TodoState = {
      ...seed,
      todos: seed.todos.map(todo =>
        todo.id === 4 ? { ...todo, status, priority: 1 } : todo,
      ),
    }

    const assigned = apply(legacy, {
      action: "priority",
      id: 3,
      priority: 1,
    }).state

    assert.equal(assigned.todos[2]?.priority, 1)
    assert.deepEqual(assigned.todos[3], legacy.todos[3])

    const ordered = apply(assigned, {
      action: "priority_order",
      ids: [2, 3, 1],
    }).state

    expectRanks(assigned, ordered, { 2: 1, 3: 2, 1: 3 })
  }
})

test("completion and cancellation release only their own slot; reopening never reclaims it", () => {
  for (const status of ["completed", "cancelled"] as const) {
    const finished = apply(seed, { action: "status", id: 1, status }).state

    assert.equal(finished.todos[0]?.priority, undefined)
    assert.deepEqual(finished.todos.slice(1), seed.todos.slice(1))

    const reassigned = apply(finished, {
      action: "priority",
      id: 3,
      priority: 2,
    }).state
    const reopened = apply(reassigned, {
      action: "status",
      id: 1,
      status: "pending",
    }).state

    assert.equal(reopened.todos[0]?.priority, undefined)
    assert.equal(reopened.todos[2]?.priority, 2)
    assert.equal(reopened.todos[1]?.priority, 8)
    assert.deepEqual(reopened.todos[0]?.replies, seed.todos[0]?.replies)
  }

  const finished = apply(seed, { action: "toggle", id: 1 }).state

  assert.equal(finished.todos[0]?.priority, undefined)

  const reopened = apply(finished, { action: "toggle", id: 1 }).state

  assert.equal(reopened.todos[0]?.status, "pending")
  assert.equal(reopened.todos[0]?.priority, undefined)
  assert.equal(reopened.todos[1]?.priority, 8)
})

test("legacy terminal reopening paths cannot restore a now-occupied historical rank", () => {
  for (const status of ["completed", "cancelled"] as const) {
    const legacy: TodoState = {
      ...seed,
      todos: seed.todos.map(todo =>
        todo.id === 4 ? { ...todo, status, priority: 2 } : todo,
      ),
    }

    for (const request of [
      { action: "status", id: 4, status: "pending" },
      { action: "status", id: 4, status: "deferred" },
      { action: "unblock", id: 4 },
      { action: "block", id: 4, reason: "Explicit hold" },
    ]) {
      const reopened = apply(legacy, request).state

      assert.equal(reopened.todos[3]?.priority, undefined)
      assert.deepEqual(reopened.todos.slice(0, 3), legacy.todos.slice(0, 3))
    }
  }
})

test("terminal tasks cannot be assigned active absolute, relative or bulk ranks", () => {
  for (const request of [
    { action: "priority", id: 4, priority: 1 },
    { action: "priority_relative", id: 4, referenceId: 1, position: "above" },
    { action: "priority_relative", id: 3, referenceId: 4, position: "below" },
    { action: "priority_order", ids: [1, 2, 4] },
  ]) {
    const decoded = decodeTodoControl(request)

    assert.ok(Either.isRight(decoded))

    const result = Effect.runSync(
      Effect.either(
        Effect.flatMap(parseTodoAction(decoded.right), action =>
          transitionTodoState(seed, action),
        ),
      ),
    )

    assert.ok(Either.isLeft(result), JSON.stringify(request))
    assert.equal(result.left._tag, "TodoInputError")
  }

  const cleared = apply(seed, {
    action: "priority",
    id: 4,
    priority: null,
  }).state

  assert.equal(cleared.todos[3]?.priority, undefined)
})

test("direct parser rejects sparse JavaScript ID arrays with a typed failure", () => {
  const ids = new Array<number>(1)

  const result = Effect.runSync(
    Effect.either(parseTodoAction({ action: "priority_order", ids })),
  )

  assert.ok(Either.isLeft(result))
  assert.equal(result.left.code, "invalid_priority")
})

test("direct transition rejects sparse JavaScript ID arrays without throwing", () => {
  const ids = new Array<number>(1)

  const result = Effect.runSync(
    Effect.either(transitionTodoState(seed, { action: "priority_order", ids })),
  )

  assert.ok(Either.isLeft(result))
  assert.equal(result.left._tag, "TodoInputError")
})

test("valid-shaped invalid priority operations return typed domain failures without changing tasks", () => {
  for (const { request, tag } of [
    {
      request: {
        action: "priority_relative",
        id: 1,
        referenceId: 1,
        position: "above",
      },
      tag: "TodoInputError",
    },
    {
      request: {
        action: "priority_relative",
        id: 1,
        referenceId: 3,
        position: "above",
      },
      tag: "TodoInputError",
    },
    {
      request: {
        action: "priority_relative",
        id: 99,
        referenceId: 1,
        position: "below",
      },
      tag: "TodoNotFoundError",
    },
    {
      request: {
        action: "priority_relative",
        id: 1,
        referenceId: 99,
        position: "below",
      },
      tag: "TodoNotFoundError",
    },
    { request: { action: "priority_order", ids: [1] }, tag: "TodoInputError" },
    {
      request: { action: "priority_order", ids: [1, 2, 99] },
      tag: "TodoNotFoundError",
    },
    {
      request: { action: "priority_order", ids: [1, 2, 4] },
      tag: "TodoInputError",
    },
  ] as const) {
    const state = structuredClone(seed)
    const before = structuredClone(state)
    const decoded = decodeTodoControl(request)

    assert.ok(Either.isRight(decoded), JSON.stringify(request))

    const result = Effect.runSync(
      Effect.either(
        Effect.flatMap(parseTodoAction(decoded.right), action =>
          transitionTodoState(state, action),
        ),
      ),
    )

    assert.ok(Either.isLeft(result), JSON.stringify(request))
    assert.equal(result.left._tag, tag, JSON.stringify(request))
    assert.equal(result.left.action, request.action)
    if (result.left._tag === "TodoInputError")
      assert.equal(result.left.code, "invalid_priority")

    assert.deepEqual(state, before, JSON.stringify(request))
  }
})

test("malformed priority requests fail shared decoding before domain execution", () => {
  for (const request of [
    { action: "priority_order", ids: [1, 1, 2] },
    { action: "priority_order", ids: [] },
    { action: "priority_order", ids: [1, 2.5] },
    { action: "priority_order", ids: ["1"] },
    { action: "priority_relative", id: 1, referenceId: 0, position: "above" },
    {
      action: "priority_relative",
      id: 1,
      referenceId: 2,
      position: "sideways",
    },
  ]) {
    const decoded = decodeTodoControl(request)

    assert.ok(Either.isLeft(decoded), JSON.stringify(request))
    assert.equal(decoded.left._tag, "TodoControlError")
  }
})
