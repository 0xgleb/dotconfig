import assert from "node:assert/strict"
import test from "node:test"
import { Effect, Either, Option } from "effect"
import { decodeTodoState, validateTodoState, type TodoState } from "./state.ts"

test("persisted state is decoded instead of cast", () => {
  const valid = decodeTodoState({
    todos: [
      { id: 1, text: "Saved", status: "pending" },
      {
        id: 2,
        text: "Blocked",
        status: "blocked",
        reason: "External dependency",
      },
    ],
    nextId: 3,
  })
  const invalid = decodeTodoState({
    todos: [{ id: "one", text: "Broken", status: "pending" }],
    nextId: 2,
  })

  assert.equal(Option.isSome(valid), true)
  assert.equal(Option.isNone(invalid), true)
  if (Option.isSome(valid))
    assert.ok(
      Either.isRight(
        Effect.runSync(Effect.either(validateTodoState(valid.value))),
      ),
    )
})

test("persisted optional todo fields require omission rather than explicit undefined", () => {
  for (const status of ["pending", "deferred", "blocked"] as const) {
    const base = {
      id: 1,
      text: "Saved",
      status,
      ...(status === "blocked" ? { reason: "Waiting" } : {}),
    }
    for (const field of [
      "replies",
      "statusChangedAt",
      ...(status === "deferred" ? ["remindAt"] : []),
    ]) {
      const state = { todos: [{ ...base, [field]: undefined }], nextId: 2 }
      assert.equal(
        Option.isNone(decodeTodoState(state)),
        true,
        `${status}.${field}`,
      )
    }
    assert.equal(
      Option.isSome(decodeTodoState({ todos: [base], nextId: 2 })),
      true,
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
})

test("malformed persisted priority is rejected, never silently decoded as unassigned", () => {
  const initial: TodoState = {
    todos: [{ id: 1, text: "Saved", status: "pending" }],
    nextId: 2,
  }
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
  const result = Effect.runSync(
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

test("historical estimates and unestimated tasks round-trip without data loss", () => {
  const state = {
    nextId: 3,
    todos: [
      { id: 1, text: "Saved", status: "in_progress", effort: 3 },
      {
        id: 2,
        text: "Check integration",
        parentId: 1,
        status: "blocked",
        reason: "Awaiting evidence",
      },
    ],
  }
  assert.deepEqual(decodeTodoState(state), Option.some(state))
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
