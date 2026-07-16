import { Data, Effect, Option, Schema } from "effect";

export type TodoStatus = "pending" | "completed";

export interface Todo {
  readonly id: number;
  readonly text: string;
  readonly status: TodoStatus;
}

export interface TodoState {
  readonly todos: ReadonlyArray<Todo>;
  readonly nextId: number;
}

export type TodoRequest =
  | { readonly action: "list" }
  | { readonly action: "add"; readonly text?: string }
  | { readonly action: "toggle"; readonly id?: number }
  | { readonly action: "clear" };

export type TodoAction =
  | { readonly action: "list" }
  | { readonly action: "add"; readonly text: string }
  | { readonly action: "toggle"; readonly id: number }
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
  action: "toggle";
  message: string;
}> {}

export const emptyTodoState: TodoState = { todos: [], nextId: 1 };

const TodoSchema = Schema.Struct({
  id: Schema.Number,
  text: Schema.String,
  status: Schema.Literal("pending", "completed"),
});

const TodoStateSchema = Schema.Struct({
  todos: Schema.Array(TodoSchema),
  nextId: Schema.Number,
});

const TodoDetailsSchema = Schema.Union(
  Schema.Struct({
    outcome: Schema.Literal("success"),
    action: Schema.Literal("list", "add", "toggle", "clear"),
    state: TodoStateSchema,
  }),
  Schema.Struct({
    outcome: Schema.Literal("error"),
    action: Schema.Literal("list", "add", "toggle", "clear"),
    state: TodoStateSchema,
    error: Schema.String,
  }),
);

export function decodeTodoState(value: unknown): Option.Option<TodoState> {
  return Schema.decodeUnknownOption(TodoStateSchema)(value);
}

export function decodeTodoDetails(value: unknown): Option.Option<TodoDetails> {
  return Schema.decodeUnknownOption(TodoDetailsSchema)(value);
}

export function transitionTodoState(
  state: TodoState,
  action: TodoAction,
): Effect.Effect<TodoTransition, TodoNotFoundError> {
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
      const status: TodoStatus = target.status === "pending" ? "completed" : "pending";
      return Effect.succeed({
        action: "toggle",
        state: {
          todos: state.todos.map((todo) => (todo.id === target.id ? { ...todo, status } : todo)),
          nextId: state.nextId,
        },
        message: `Todo #${target.id} ${status}`,
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
}

export function parseTodoAction(request: TodoRequest): Effect.Effect<TodoAction, TodoInputError> {
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
    case "clear":
      return Effect.succeed(request);
  }
}

function formatTodoList(todos: ReadonlyArray<Todo>): string {
  return todos.length === 0
    ? "No todos"
    : todos
        .map((todo) => `[${todo.status === "completed" ? "x" : " "}] #${todo.id}: ${todo.text}`)
        .join("\n");
}
