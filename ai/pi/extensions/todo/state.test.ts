import assert from "node:assert/strict";
import test from "node:test";
import { Effect, Either, Option } from "effect";
import { decodeTodoDetails, decodeTodoState, emptyTodoState, parseTodoAction, transitionTodoState } from "./state.ts";

test("adding a todo creates immutable pending state", async () => {
  const result = await Effect.runPromise(
    transitionTodoState(emptyTodoState, { action: "add", text: "Fix Pi" }),
  );

  assert.deepEqual(result, {
    action: "add",
    state: {
      todos: [{ id: 1, text: "Fix Pi", status: "pending" }],
      nextId: 2,
    },
    message: "Added todo #1: Fix Pi",
  });
  assert.deepEqual(emptyTodoState, { todos: [], nextId: 1 });
});

test("toggle changes only the targeted todo status", async () => {
  const state = {
    todos: [
      { id: 1, text: "First", status: "pending" as const },
      { id: 2, text: "Second", status: "completed" as const },
    ],
    nextId: 3,
  };
  const result = await Effect.runPromise(transitionTodoState(state, { action: "toggle", id: 1 }));

  assert.deepEqual(result.state.todos, [
    { id: 1, text: "First", status: "completed" },
    { id: 2, text: "Second", status: "completed" },
  ]);
  assert.deepEqual(state.todos[0], { id: 1, text: "First", status: "pending" });
});

test("blocked work requires a reason and can be unblocked", async () => {
  const added = await Effect.runPromise(transitionTodoState(emptyTodoState, { action: "add", text: "Deploy" }));
  const blocked = await Effect.runPromise(
    transitionTodoState(added.state, { action: "block", id: 1, reason: "Waiting for production access" }),
  );
  assert.deepEqual(blocked.state.todos, [
    { id: 1, text: "Deploy", status: "blocked", reason: "Waiting for production access" },
  ]);
  const unblocked = await Effect.runPromise(transitionTodoState(blocked.state, { action: "unblock", id: 1 }));
  assert.deepEqual(unblocked.state.todos, [{ id: 1, text: "Deploy", status: "pending" }]);
  assert.equal(Either.isLeft(await Effect.runPromise(Effect.either(parseTodoAction({ action: "block", id: 1 })))), true);
});

test("replies preserve the original blocker and survive unblocking", async () => {
  const state = {
    todos: [{ id: 1, text: "Inspect browser", status: "blocked" as const, reason: "Need user context" }],
    nextId: 2,
  };
  const replied = await Effect.runPromise(
    transitionTodoState(state, { action: "reply", id: 1, text: "Browser navigation has not been visible enough." }),
  );
  assert.deepEqual(replied.state.todos, [
    {
      id: 1,
      text: "Inspect browser",
      status: "blocked",
      reason: "Need user context",
      replies: ["Browser navigation has not been visible enough."],
    },
  ]);
  const unblocked = await Effect.runPromise(transitionTodoState(replied.state, { action: "unblock", id: 1 }));
  assert.deepEqual(unblocked.state.todos, [
    {
      id: 1,
      text: "Inspect browser",
      status: "pending",
      replies: ["Browser navigation has not been visible enough."],
    },
  ]);
});

test("invalid add and toggle inputs fail through the typed channel", async () => {
  const missingText = await Effect.runPromise(
    Effect.either(parseTodoAction({ action: "add" })),
  );
  const missingTodo = await Effect.runPromise(
    Effect.either(transitionTodoState(emptyTodoState, { action: "toggle", id: 7 })),
  );

  assert.equal(Either.isLeft(missingText), true);
  assert.equal(Either.isLeft(missingTodo), true);
  if (Either.isLeft(missingText)) assert.equal(missingText.left.message, "text required for add");
  if (Either.isLeft(missingTodo)) assert.equal(missingTodo.left.message, "Todo #7 not found");
});

test("clear resets todos and identifiers", async () => {
  const result = await Effect.runPromise(
    transitionTodoState(
      { todos: [{ id: 4, text: "Old", status: "completed" }], nextId: 5 },
      { action: "clear" },
    ),
  );

  assert.deepEqual(result.state, emptyTodoState);
  assert.equal(result.message, "Cleared 1 todo");
});

test("persisted state is decoded instead of cast", () => {
  const valid = decodeTodoState({
    todos: [
      { id: 1, text: "Saved", status: "pending" },
      { id: 2, text: "Blocked", status: "blocked", reason: "External dependency" },
    ],
    nextId: 3,
  });
  const invalid = decodeTodoState({ todos: [{ id: "one", text: "Broken", status: "pending" }], nextId: 2 });

  assert.equal(Option.isSome(valid), true);
  assert.equal(Option.isNone(invalid), true);
});

test("persisted tool details validate action and state together", () => {
  const valid = decodeTodoDetails({
    outcome: "success",
    action: "add",
    state: { todos: [{ id: 1, text: "Saved", status: "pending" }], nextId: 2 },
  });
  const invalid = decodeTodoDetails({
    outcome: "success",
    action: "destroy",
    state: { todos: [], nextId: 1 },
  });

  assert.equal(Option.isSome(valid), true);
  assert.equal(Option.isNone(invalid), true);
});
