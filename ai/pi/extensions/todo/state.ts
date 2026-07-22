import { Data, Effect, Option, Schema } from "effect";

export type TodoStatus = "pending" | "completed" | "blocked";

interface TodoBase {
  readonly id: number;
  readonly text: string;
}

export type Todo =
  | (TodoBase & { readonly status: "pending" | "completed" })
  | (TodoBase & { readonly status: "blocked"; readonly reason: string });

export interface TodoState {
  readonly todos: ReadonlyArray<Todo>;
  readonly nextId: number;
}

export type TodoRequest =
  | { readonly action: "list" }
  | { readonly action: "add"; readonly text?: string }
  | { readonly action: "toggle"; readonly id?: number }
  | { readonly action: "block"; readonly id?: number; readonly reason?: string }
  | { readonly action: "unblock"; readonly id?: number }
  | { readonly action: "clear" };

export type TodoAction =
  | { readonly action: "list" }
  | { readonly action: "add"; readonly text: string }
  | { readonly action: "toggle"; readonly id: number }
  | { readonly action: "block"; readonly id: number; readonly reason: string }
  | { readonly action: "unblock"; readonly id: number }
  | { readonly action: "clear" };

export interface TodoTransition {
  readonly action: TodoAction["action"];
  readonly state: TodoState;
  readonly message: string;
}

export type TodoDetails =
  | {
      readonly outcome: "success";
      readonly action: TodoAction["action"];
      readonly state: TodoState;
    }
  | {
      readonly outcome: "error";
      readonly action: TodoAction["action"];
      readonly state: TodoState;
      readonly error: string;
    };

export class TodoInputError extends Data.TaggedError("TodoInputError")<{
  action: TodoRequest["action"];
  message: string;
}> {}

export class TodoNotFoundError extends Data.TaggedError("TodoNotFoundError")<{
  action: "toggle" | "block" | "unblock";
  message: string;
}> {}

export const emptyTodoState: TodoState = { todos: [], nextId: 1 };

const TodoSchema = Schema.Union(
  Schema.Struct({
    id: Schema.Number,
    text: Schema.String,
    status: Schema.Literal("pending", "completed"),
  }),
  Schema.Struct({
    id: Schema.Number,
    text: Schema.String,
    status: Schema.Literal("blocked"),
    reason: Schema.String,
  }),
);

const TodoStateSchema = Schema.Struct({
  todos: Schema.Array(TodoSchema),
  nextId: Schema.Number,
});

const TodoActionSchema = Schema.Literal("list", "add", "toggle", "block", "unblock", "clear");

const TodoDetailsSchema = Schema.Union(
  Schema.Struct({
    outcome: Schema.Literal("success"),
    action: TodoActionSchema,
    state: TodoStateSchema,
  }),
  Schema.Struct({
    outcome: Schema.Literal("error"),
    action: TodoActionSchema,
    state: TodoStateSchema,
    error: Schema.String,
  }),
);

export const decodeTodoState: (value: unknown) => Option.Option<TodoState> = (value) =>
  Schema.decodeUnknownOption(TodoStateSchema)(value);

export const decodeTodoDetails: (value: unknown) => Option.Option<TodoDetails> = (value) =>
  Schema.decodeUnknownOption(TodoDetailsSchema)(value);

const pendingTodo: (todo: Todo) => Todo = (todo) => ({ id: todo.id, text: todo.text, status: "pending" });

export const transitionTodoState: (
  state: TodoState,
  action: TodoAction,
) => Effect.Effect<TodoTransition, TodoNotFoundError> = (state, action) => {
  switch (action.action) {
    case "list":
      return Effect.succeed({ action: "list", state, message: formatTodoList(state.todos) });

    case "add": {
      const todo: Todo = { id: state.nextId, text: action.text, status: "pending" };
      return Effect.succeed({
        action: "add",
        state: { todos: [...state.todos, todo], nextId: state.nextId + 1 },
        message: `Added todo #${todo.id}: ${todo.text}`,
      });
    }

    case "toggle": {
      const target = state.todos.find(({ id }) => id === action.id);
      if (!target) {
        return Effect.fail(new TodoNotFoundError({ action: "toggle", message: `Todo #${action.id} not found` }));
      }
      const replacement: Todo =
        target.status === "pending"
          ? { id: target.id, text: target.text, status: "completed" }
          : pendingTodo(target);
      return Effect.succeed({
        action: "toggle",
        state: {
          todos: state.todos.map((todo) => (todo.id === target.id ? replacement : todo)),
          nextId: state.nextId,
        },
        message: `Todo #${target.id} ${replacement.status}`,
      });
    }

    case "block": {
      const target = state.todos.find(({ id }) => id === action.id);
      if (!target) {
        return Effect.fail(new TodoNotFoundError({ action: "block", message: `Todo #${action.id} not found` }));
      }
      const replacement: Todo = { id: target.id, text: target.text, status: "blocked", reason: action.reason };
      return Effect.succeed({
        action: "block",
        state: {
          todos: state.todos.map((todo) => (todo.id === target.id ? replacement : todo)),
          nextId: state.nextId,
        },
        message: `Todo #${target.id} blocked: ${action.reason}`,
      });
    }

    case "unblock": {
      const target = state.todos.find(({ id }) => id === action.id);
      if (!target) {
        return Effect.fail(new TodoNotFoundError({ action: "unblock", message: `Todo #${action.id} not found` }));
      }
      return Effect.succeed({
        action: "unblock",
        state: {
          todos: state.todos.map((todo) => (todo.id === target.id ? pendingTodo(todo) : todo)),
          nextId: state.nextId,
        },
        message: `Todo #${target.id} unblocked`,
      });
    }

    case "clear": {
      const count = state.todos.length;
      return Effect.succeed({
        action: "clear",
        state: emptyTodoState,
        message: `Cleared ${count} ${count === 1 ? "todo" : "todos"}`,
      });
    }
  }
};

export const parseTodoAction: (request: TodoRequest) => Effect.Effect<TodoAction, TodoInputError> = (request) => {
  switch (request.action) {
    case "list":
      return Effect.succeed(request);
    case "add": {
      const text = request.text?.trim();
      return text
        ? Effect.succeed({ action: "add", text })
        : Effect.fail(new TodoInputError({ action: "add", message: "text required for add" }));
    }
    case "toggle":
      return request.id === undefined
        ? Effect.fail(new TodoInputError({ action: "toggle", message: "id required for toggle" }))
        : Effect.succeed({ action: "toggle", id: request.id });
    case "block": {
      if (request.id === undefined) {
        return Effect.fail(new TodoInputError({ action: "block", message: "id required for block" }));
      }
      const reason = request.reason?.trim();
      return reason
        ? Effect.succeed({ action: "block", id: request.id, reason })
        : Effect.fail(new TodoInputError({ action: "block", message: "reason required for block" }));
    }
    case "unblock":
      return request.id === undefined
        ? Effect.fail(new TodoInputError({ action: "unblock", message: "id required for unblock" }))
        : Effect.succeed({ action: "unblock", id: request.id });
    case "clear":
      return Effect.succeed(request);
  }
};

const formatTodoList: (todos: ReadonlyArray<Todo>) => string = (todos) =>
  todos.length === 0
    ? "No todos"
    : todos
        .map((todo) =>
          todo.status === "blocked"
            ? `[!] #${todo.id}: ${todo.text} — blocked: ${todo.reason}`
            : `[${todo.status === "completed" ? "x" : " "}] #${todo.id}: ${todo.text}`,
        )
        .join("\n");
