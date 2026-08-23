import assert from "node:assert/strict"
import test from "node:test"
import { Effect, Either, Option } from "effect"
import {
  decodeTodoDetails,
  decodeTodoState,
  emptyTodoState,
  nextDeferredReminderAt,
  parseTodoAction,
  transitionTodoState,
  wakeDueDeferredTodos,
} from "./state.ts"

test("adding a todo creates immutable not-started state", async () => {
  const result = await Effect.runPromise(
    transitionTodoState(emptyTodoState, { action: "add", text: "Fix Pi" }),
  )

  assert.deepEqual(result, {
    action: "add",
    state: {
      todos: [{ id: 1, text: "Fix Pi", status: "pending" }],
      nextId: 2,
    },
    message: "Added todo #1: Fix Pi",
  })
  assert.deepEqual(emptyTodoState, { todos: [], nextId: 1 })
})

test("toggle changes only the targeted todo status", async () => {
  const state = {
    todos: [
      { id: 1, text: "First", status: "pending" as const },
      { id: 2, text: "Second", status: "completed" as const },
    ],
    nextId: 3,
  }
  const result = await Effect.runPromise(
    transitionTodoState(state, { action: "toggle", id: 1 }, 1_000),
  )

  assert.deepEqual(result.state.todos, [
    { id: 1, text: "First", status: "completed", statusChangedAt: 1_000 },
    { id: 2, text: "Second", status: "completed" },
  ])
  assert.deepEqual(state.todos[0], { id: 1, text: "First", status: "pending" })
})

test("explicit statuses cover in-progress, in-review, cancelled, and deferred work", async () => {
  const state = {
    todos: [{ id: 1, text: "Shape UI", status: "pending" as const }],
    nextId: 2,
  }
  const started = await Effect.runPromise(
    transitionTodoState(
      state,
      { action: "status", id: 1, status: "in_progress" },
      1_000,
    ),
  )
  const reviewing = await Effect.runPromise(
    transitionTodoState(
      started.state,
      { action: "status", id: 1, status: "in_review" },
      2_000,
    ),
  )
  const cancelled = await Effect.runPromise(
    transitionTodoState(
      reviewing.state,
      { action: "status", id: 1, status: "cancelled" },
      3_000,
    ),
  )
  const deferred = await Effect.runPromise(
    transitionTodoState(
      cancelled.state,
      { action: "status", id: 1, status: "deferred" },
      4_000,
    ),
  )

  assert.deepEqual(started.state.todos, [
    { id: 1, text: "Shape UI", status: "in_progress" },
  ])
  assert.deepEqual(reviewing.state.todos, [
    { id: 1, text: "Shape UI", status: "in_review" },
  ])
  assert.deepEqual(cancelled.state.todos, [
    { id: 1, text: "Shape UI", status: "cancelled", statusChangedAt: 3_000 },
  ])
  assert.deepEqual(deferred.state.todos, [
    { id: 1, text: "Shape UI", status: "deferred" },
  ])
})

test("deferred work can carry a timezone-qualified durable reminder", async () => {
  const now = Date.parse("2026-07-23T08:00:00Z")
  const remindAt = "2026-07-23T09:30:00Z"
  const action = await Effect.runPromise(
    parseTodoAction(
      { action: "status", id: 1, status: "deferred", remindAt },
      now,
    ),
  )
  const result = await Effect.runPromise(
    transitionTodoState(
      {
        todos: [{ id: 1, text: "Resume review", status: "pending" }],
        nextId: 2,
      },
      action,
      now,
    ),
  )

  assert.deepEqual(result.state.todos, [
    {
      id: 1,
      text: "Resume review",
      status: "deferred",
      remindAt: Date.parse(remindAt),
    },
  ])
  assert.equal(
    result.message,
    "Todo #1 deferred until 2026-07-23T09:30:00.000Z",
  )
  assert.equal(Option.isSome(decodeTodoState(result.state)), true)
})

test("reminder input rejects ambiguous, elapsed, and non-deferred schedules", async () => {
  const now = Date.parse("2026-07-23T08:00:00Z")
  const cases = [
    {
      action: "status" as const,
      id: 1,
      status: "deferred" as const,
      remindAt: "2026-07-23 09:30",
    },
    {
      action: "status" as const,
      id: 1,
      status: "deferred" as const,
      remindAt: "2026-07-23T07:30:00Z",
    },
    {
      action: "status" as const,
      id: 1,
      status: "pending" as const,
      remindAt: "2026-07-23T09:30:00Z",
    },
  ]

  for (const request of cases) {
    assert.equal(
      Either.isLeft(
        await Effect.runPromise(Effect.either(parseTodoAction(request, now))),
      ),
      true,
    )
  }
})

test("due deferred reminders wake together while future and indefinite deferrals remain", () => {
  const now = Date.parse("2026-07-23T10:00:00Z")
  const state = {
    todos: [
      { id: 1, text: "Due", status: "deferred" as const, remindAt: now - 1 },
      {
        id: 2,
        text: "Future",
        status: "deferred" as const,
        remindAt: now + 60_000,
      },
      { id: 3, text: "Indefinite", status: "deferred" as const },
      { id: 4, text: "Active", status: "pending" as const },
    ],
    nextId: 5,
  }

  assert.equal(nextDeferredReminderAt(state), now - 1)
  const wake = wakeDueDeferredTodos(state, now)
  assert.deepEqual(
    wake.woken.map(({ id }) => id),
    [1],
  )
  assert.deepEqual(wake.state.todos, [
    { id: 1, text: "Due", status: "pending" },
    { id: 2, text: "Future", status: "deferred", remindAt: now + 60_000 },
    { id: 3, text: "Indefinite", status: "deferred" },
    { id: 4, text: "Active", status: "pending" },
  ])
  assert.equal(nextDeferredReminderAt(wake.state), now + 60_000)
})

test("blocked work requires a reason and can be unblocked", async () => {
  const added = await Effect.runPromise(
    transitionTodoState(emptyTodoState, { action: "add", text: "Deploy" }),
  )
  const blocked = await Effect.runPromise(
    transitionTodoState(added.state, {
      action: "block",
      id: 1,
      reason: "Waiting for production access",
    }),
  )
  assert.deepEqual(blocked.state.todos, [
    {
      id: 1,
      text: "Deploy",
      status: "blocked",
      reason: "Waiting for production access",
    },
  ])
  const unblocked = await Effect.runPromise(
    transitionTodoState(blocked.state, { action: "unblock", id: 1 }),
  )
  assert.deepEqual(unblocked.state.todos, [
    { id: 1, text: "Deploy", status: "pending" },
  ])
  assert.equal(
    Either.isLeft(
      await Effect.runPromise(
        Effect.either(parseTodoAction({ action: "block", id: 1 })),
      ),
    ),
    true,
  )
})

test("replies preserve the original blocker and survive unblocking", async () => {
  const state = {
    todos: [
      {
        id: 1,
        text: "Inspect browser",
        status: "blocked" as const,
        reason: "Need user context",
      },
    ],
    nextId: 2,
  }
  const replied = await Effect.runPromise(
    transitionTodoState(state, {
      action: "reply",
      id: 1,
      text: "Browser navigation has not been visible enough.",
    }),
  )
  assert.deepEqual(replied.state.todos, [
    {
      id: 1,
      text: "Inspect browser",
      status: "blocked",
      reason: "Need user context",
      replies: ["Browser navigation has not been visible enough."],
    },
  ])
  const unblocked = await Effect.runPromise(
    transitionTodoState(replied.state, { action: "unblock", id: 1 }),
  )
  assert.deepEqual(unblocked.state.todos, [
    {
      id: 1,
      text: "Inspect browser",
      status: "pending",
      replies: ["Browser navigation has not been visible enough."],
    },
  ])
})

test("invalid add, toggle, and status inputs fail through the typed channel", async () => {
  const missingText = await Effect.runPromise(
    Effect.either(parseTodoAction({ action: "add" })),
  )
  const missingTodo = await Effect.runPromise(
    Effect.either(
      transitionTodoState(emptyTodoState, { action: "toggle", id: 7 }),
    ),
  )
  const missingStatus = await Effect.runPromise(
    Effect.either(parseTodoAction({ action: "status", id: 1 })),
  )

  assert.equal(Either.isLeft(missingText), true)
  assert.equal(Either.isLeft(missingTodo), true)
  assert.equal(Either.isLeft(missingStatus), true)
  if (Either.isLeft(missingText))
    assert.equal(missingText.left.message, "text required for add")
  if (Either.isLeft(missingTodo))
    assert.equal(missingTodo.left.message, "Todo #7 not found")
  if (Either.isLeft(missingStatus))
    assert.equal(missingStatus.left.message, "status required for status")
})

test("clear resets todos and identifiers", async () => {
  const result = await Effect.runPromise(
    transitionTodoState(
      { todos: [{ id: 4, text: "Old", status: "completed" }], nextId: 5 },
      { action: "clear" },
    ),
  )

  assert.deepEqual(result.state, emptyTodoState)
  assert.equal(result.message, "Cleared 1 todo")
})

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
})

test("persisted tool details validate action and state together", () => {
  const valid = decodeTodoDetails({
    outcome: "success",
    action: "add",
    state: { todos: [{ id: 1, text: "Saved", status: "pending" }], nextId: 2 },
  })
  const invalid = decodeTodoDetails({
    outcome: "success",
    action: "destroy",
    state: { todos: [], nextId: 1 },
  })

  assert.equal(Option.isSome(valid), true)
  assert.equal(Option.isNone(invalid), true)
})
