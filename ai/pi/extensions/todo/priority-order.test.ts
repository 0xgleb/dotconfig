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
    before.todos.map(todo => ({ ...todo, priority: ranks[todo.id] })),
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
  expectRanks(estimated, above, { 1: 1, 3: 2, 2: 3, 4: 4 })
  const below = apply(above, {
    action: "priority_relative",
    id: 1,
    referenceId: 2,
    position: "below",
  }).state
  expectRanks(above, below, { 3: 1, 2: 2, 1: 3, 4: 4 })
  assert.equal(JSON.stringify(estimated), before)
})

test("one bulk order includes all assigned tasks and can assign previously unranked work", () => {
  const before = JSON.stringify(seed)
  const ordered = apply(seed, {
    action: "priority_order",
    ids: [4, 2, 3, 1],
  }).state
  expectRanks(seed, ordered, { 4: 1, 2: 2, 3: 3, 1: 4 })
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

test("invalid relative or bulk requests fail without changing authoritative tasks", () => {
  const before = JSON.stringify(seed)
  for (const request of [
    { action: "priority_relative", id: 1, referenceId: 1, position: "above" },
    { action: "priority_relative", id: 1, referenceId: 3, position: "above" },
    { action: "priority_relative", id: 99, referenceId: 1, position: "below" },
    { action: "priority_order", ids: [1, 2] },
    { action: "priority_order", ids: [1, 2, 4, 99] },
    { action: "priority_order", ids: [1, 1, 2, 4] },
    { action: "priority_order", ids: [] },
  ]) {
    const decoded = decodeTodoControl(request)
    if (Either.isRight(decoded)) {
      const result = Effect.runSync(
        Effect.either(
          Effect.flatMap(parseTodoAction(decoded.right), action =>
            transitionTodoState(seed, action),
          ),
        ),
      )
      assert.ok(Either.isLeft(result), JSON.stringify(request))
    }
  }
  for (const request of [
    { action: "priority_order", ids: [1, 2.5] },
    { action: "priority_order", ids: ["1"] },
    { action: "priority_relative", id: 1, referenceId: 0, position: "above" },
    {
      action: "priority_relative",
      id: 1,
      referenceId: 2,
      position: "sideways",
    },
  ])
    assert.ok(Either.isLeft(decodeTodoControl(request)))
  assert.equal(JSON.stringify(seed), before)
})
