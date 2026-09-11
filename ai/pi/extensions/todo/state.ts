import { Data, Effect, Option, Schema } from "effect"

export type TodoStatus =
  | "pending"
  | "in_progress"
  | "in_review"
  | "completed"
  | "cancelled"
  | "blocked"
  | "deferred"
export type SettableTodoStatus = Exclude<TodoStatus, "blocked">
type ImmediateTodoStatus = Exclude<SettableTodoStatus, "deferred">

interface TodoBase {
  readonly id: number
  readonly text: string
  readonly replies?: ReadonlyArray<string>
  readonly statusChangedAt?: number
}

export type Todo =
  | (TodoBase & { readonly status: ImmediateTodoStatus })
  | (TodoBase & { readonly status: "deferred"; readonly remindAt?: number })
  | (TodoBase & { readonly status: "blocked"; readonly reason: string })

export interface TodoState {
  readonly todos: ReadonlyArray<Todo>
  readonly nextId: number
}

export type TodoRequest =
  | { readonly action: "list" }
  | { readonly action: "add"; readonly text?: string }
  | { readonly action: "toggle"; readonly id?: number }
  | {
      readonly action: "status"
      readonly id?: number
      readonly status?: SettableTodoStatus
      readonly remindAt?: string
    }
  | { readonly action: "block"; readonly id?: number; readonly reason?: string }
  | { readonly action: "reply"; readonly id?: number; readonly text?: string }
  | { readonly action: "unblock"; readonly id?: number }
  | { readonly action: "clear" }

export type TodoAction =
  | { readonly action: "list" }
  | { readonly action: "add"; readonly text: string }
  | { readonly action: "toggle"; readonly id: number }
  | {
      readonly action: "status"
      readonly id: number
      readonly status: SettableTodoStatus
      readonly remindAt?: number
    }
  | { readonly action: "block"; readonly id: number; readonly reason: string }
  | { readonly action: "reply"; readonly id: number; readonly text: string }
  | { readonly action: "unblock"; readonly id: number }
  | { readonly action: "clear" }

export interface TodoTransition {
  readonly action: TodoAction["action"]
  readonly state: TodoState
  readonly message: string
}

export type TodoDetails =
  | {
      readonly outcome: "success"
      readonly action: TodoAction["action"]
      readonly state: TodoState
    }
  | {
      readonly outcome: "error"
      readonly action: TodoAction["action"]
      readonly state: TodoState
      readonly error: string
    }

export class TodoInputError extends Data.TaggedError("TodoInputError")<{
  action: TodoRequest["action"]
  message: string
}> {}

export class TodoNotFoundError extends Data.TaggedError("TodoNotFoundError")<{
  action: "toggle" | "status" | "block" | "reply" | "unblock"
  message: string
}> {}

export const emptyTodoState: TodoState = { todos: [], nextId: 1 }

const TodoSchema = Schema.Union(
  Schema.Struct({
    id: Schema.Number,
    text: Schema.String,
    status: Schema.Literal(
      "pending",
      "in_progress",
      "in_review",
      "completed",
      "cancelled",
    ),
    replies: Schema.optionalWith(Schema.Array(Schema.String), { exact: true }),
    statusChangedAt: Schema.optionalWith(Schema.Number, { exact: true }),
  }),
  Schema.Struct({
    id: Schema.Number,
    text: Schema.String,
    status: Schema.Literal("deferred"),
    remindAt: Schema.optionalWith(Schema.Number, { exact: true }),
    replies: Schema.optionalWith(Schema.Array(Schema.String), { exact: true }),
    statusChangedAt: Schema.optionalWith(Schema.Number, { exact: true }),
  }),
  Schema.Struct({
    id: Schema.Number,
    text: Schema.String,
    status: Schema.Literal("blocked"),
    reason: Schema.String,
    replies: Schema.optionalWith(Schema.Array(Schema.String), { exact: true }),
    statusChangedAt: Schema.optionalWith(Schema.Number, { exact: true }),
  }),
)

const TodoStateSchema = Schema.Struct({
  todos: Schema.Array(TodoSchema),
  nextId: Schema.Number,
})

const TodoActionSchema = Schema.Literal(
  "list",
  "add",
  "toggle",
  "status",
  "block",
  "reply",
  "unblock",
  "clear",
)

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
)

export const decodeTodoState: (
  value: unknown,
) => Option.Option<TodoState> = value =>
  Schema.decodeUnknownOption(TodoStateSchema)(value)

export const decodeTodoDetails: (
  value: unknown,
) => Option.Option<TodoDetails> = value =>
  Schema.decodeUnknownOption(TodoDetailsSchema)(value)

const todoWithStatus: (
  todo: Todo,
  status: SettableTodoStatus,
  now?: number,
  remindAt?: number,
) => Todo = (todo, status, now, remindAt) => {
  const base: TodoBase = {
    id: todo.id,
    text: todo.text,
    ...(todo.replies && todo.replies.length > 0
      ? { replies: todo.replies }
      : {}),
    ...(now === undefined ? {} : { statusChangedAt: now }),
  }
  return status === "deferred"
    ? { ...base, status, ...(remindAt === undefined ? {} : { remindAt }) }
    : { ...base, status }
}

const pendingTodo: (todo: Todo) => Todo = todo =>
  todoWithStatus(todo, "pending")

export const transitionTodoState: (
  state: TodoState,
  action: TodoAction,
  now?: number,
) => Effect.Effect<TodoTransition, TodoNotFoundError> = (
  state,
  action,
  now,
) => {
  switch (action.action) {
    case "list":
      return Effect.succeed({
        action: "list",
        state,
        message: formatTodoList(state.todos),
      })

    case "add": {
      const todo: Todo = {
        id: state.nextId,
        text: action.text,
        status: "pending",
      }
      return Effect.succeed({
        action: "add",
        state: { todos: [...state.todos, todo], nextId: state.nextId + 1 },
        message: `Added todo #${todo.id}: ${todo.text}`,
      })
    }

    case "toggle": {
      const target = state.todos.find(({ id }) => id === action.id)
      if (!target) {
        return Effect.fail(
          new TodoNotFoundError({
            action: "toggle",
            message: `Todo #${action.id} not found`,
          }),
        )
      }
      const replacement: Todo =
        target.status === "completed"
          ? pendingTodo(target)
          : todoWithStatus(target, "completed", now)
      return Effect.succeed({
        action: "toggle",
        state: {
          todos: state.todos.map(todo =>
            todo.id === target.id ? replacement : todo,
          ),
          nextId: state.nextId,
        },
        message: `Todo #${target.id} ${replacement.status}`,
      })
    }

    case "status": {
      const target = state.todos.find(({ id }) => id === action.id)
      if (!target) {
        return Effect.fail(
          new TodoNotFoundError({
            action: "status",
            message: `Todo #${action.id} not found`,
          }),
        )
      }
      const changedAt =
        action.status === "completed" || action.status === "cancelled"
          ? now
          : undefined
      const replacement = todoWithStatus(
        target,
        action.status,
        changedAt,
        action.remindAt,
      )
      const schedule =
        replacement.status === "deferred" && replacement.remindAt !== undefined
          ? ` until ${new Date(replacement.remindAt).toISOString()}`
          : ""
      return Effect.succeed({
        action: "status",
        state: {
          todos: state.todos.map(todo =>
            todo.id === target.id ? replacement : todo,
          ),
          nextId: state.nextId,
        },
        message: `Todo #${target.id} ${replacement.status}${schedule}`,
      })
    }

    case "block": {
      const target = state.todos.find(({ id }) => id === action.id)
      if (!target) {
        return Effect.fail(
          new TodoNotFoundError({
            action: "block",
            message: `Todo #${action.id} not found`,
          }),
        )
      }
      const replacement: Todo = {
        id: target.id,
        text: target.text,
        status: "blocked",
        reason: action.reason,
        ...(target.replies && target.replies.length > 0
          ? { replies: target.replies }
          : {}),
      }
      return Effect.succeed({
        action: "block",
        state: {
          todos: state.todos.map(todo =>
            todo.id === target.id ? replacement : todo,
          ),
          nextId: state.nextId,
        },
        message: `Todo #${target.id} blocked: ${action.reason}`,
      })
    }

    case "reply": {
      const target = state.todos.find(({ id }) => id === action.id)
      if (!target) {
        return Effect.fail(
          new TodoNotFoundError({
            action: "reply",
            message: `Todo #${action.id} not found`,
          }),
        )
      }
      const replacement: Todo = {
        ...target,
        replies: [...(target.replies ?? []), action.text],
      }
      return Effect.succeed({
        action: "reply",
        state: {
          todos: state.todos.map(todo =>
            todo.id === target.id ? replacement : todo,
          ),
          nextId: state.nextId,
        },
        message: `Reply attached to todo #${target.id}`,
      })
    }

    case "unblock": {
      const target = state.todos.find(({ id }) => id === action.id)
      if (!target) {
        return Effect.fail(
          new TodoNotFoundError({
            action: "unblock",
            message: `Todo #${action.id} not found`,
          }),
        )
      }
      return Effect.succeed({
        action: "unblock",
        state: {
          todos: state.todos.map(todo =>
            todo.id === target.id ? pendingTodo(todo) : todo,
          ),
          nextId: state.nextId,
        },
        message: `Todo #${target.id} unblocked`,
      })
    }

    case "clear": {
      const count = state.todos.length
      return Effect.succeed({
        action: "clear",
        state: emptyTodoState,
        message: `Cleared ${count} ${count === 1 ? "todo" : "todos"}`,
      })
    }
  }
}

export const nextDeferredReminderAt: (
  state: TodoState,
) => number | undefined = state =>
  state.todos
    .filter(
      (todo): todo is Extract<Todo, { status: "deferred" }> =>
        todo.status === "deferred",
    )
    .flatMap(({ remindAt }) => (remindAt === undefined ? [] : [remindAt]))
    .sort((left, right) => left - right)[0]

export interface DeferredTodoWake {
  readonly state: TodoState
  readonly woken: ReadonlyArray<Extract<Todo, { status: "deferred" }>>
}

export const wakeDueDeferredTodos: (
  state: TodoState,
  now: number,
) => DeferredTodoWake = (state, now) => {
  const woken = state.todos.filter(
    (todo): todo is Extract<Todo, { status: "deferred" }> =>
      todo.status === "deferred" &&
      todo.remindAt !== undefined &&
      todo.remindAt <= now,
  )
  if (woken.length === 0) return { state, woken }
  const dueIds = new Set(woken.map(({ id }) => id))
  return {
    state: {
      todos: state.todos.map(todo =>
        dueIds.has(todo.id) ? pendingTodo(todo) : todo,
      ),
      nextId: state.nextId,
    },
    woken,
  }
}

const TIMEZONE_QUALIFIED_ISO = /^\d{4}-\d{2}-\d{2}T.+(?:Z|[+-]\d{2}:\d{2})$/

export const parseTodoAction: (
  request: TodoRequest,
  now?: number,
) => Effect.Effect<TodoAction, TodoInputError> = (
  request,
  now = Date.now(),
) => {
  switch (request.action) {
    case "list":
      return Effect.succeed(request)
    case "add": {
      const text = request.text?.trim()
      return text
        ? Effect.succeed({ action: "add", text })
        : Effect.fail(
            new TodoInputError({
              action: "add",
              message: "text required for add",
            }),
          )
    }
    case "toggle":
      return request.id === undefined
        ? Effect.fail(
            new TodoInputError({
              action: "toggle",
              message: "id required for toggle",
            }),
          )
        : Effect.succeed({ action: "toggle", id: request.id })
    case "status":
      if (request.id === undefined) {
        return Effect.fail(
          new TodoInputError({
            action: "status",
            message: "id required for status",
          }),
        )
      }
      if (request.status === undefined) {
        return Effect.fail(
          new TodoInputError({
            action: "status",
            message: "status required for status",
          }),
        )
      }
      if (request.remindAt === undefined) {
        return Effect.succeed({
          action: "status",
          id: request.id,
          status: request.status,
        })
      }
      if (request.status !== "deferred") {
        return Effect.fail(
          new TodoInputError({
            action: "status",
            message: "remindAt is valid only for deferred status",
          }),
        )
      }
      if (!TIMEZONE_QUALIFIED_ISO.test(request.remindAt)) {
        return Effect.fail(
          new TodoInputError({
            action: "status",
            message: "remindAt must be a timezone-qualified ISO-8601 time",
          }),
        )
      }
      const remindAt = Date.parse(request.remindAt)
      if (!Number.isFinite(remindAt) || remindAt <= now) {
        return Effect.fail(
          new TodoInputError({
            action: "status",
            message: "remindAt must be a valid future time",
          }),
        )
      }
      return Effect.succeed({
        action: "status",
        id: request.id,
        status: request.status,
        remindAt,
      })
    case "block": {
      if (request.id === undefined) {
        return Effect.fail(
          new TodoInputError({
            action: "block",
            message: "id required for block",
          }),
        )
      }
      const reason = request.reason?.trim()
      return reason
        ? Effect.succeed({ action: "block", id: request.id, reason })
        : Effect.fail(
            new TodoInputError({
              action: "block",
              message: "reason required for block",
            }),
          )
    }
    case "reply": {
      if (request.id === undefined) {
        return Effect.fail(
          new TodoInputError({
            action: "reply",
            message: "id required for reply",
          }),
        )
      }
      const text = request.text?.trim()
      return text
        ? Effect.succeed({ action: "reply", id: request.id, text })
        : Effect.fail(
            new TodoInputError({
              action: "reply",
              message: "text required for reply",
            }),
          )
    }
    case "unblock":
      return request.id === undefined
        ? Effect.fail(
            new TodoInputError({
              action: "unblock",
              message: "id required for unblock",
            }),
          )
        : Effect.succeed({ action: "unblock", id: request.id })
    case "clear":
      return Effect.succeed(request)
  }
}

export const todoStatusMark: (status: TodoStatus) => string = status =>
  ({
    pending: "[ ]",
    in_progress: "[/]",
    in_review: "[~]",
    completed: "[x]",
    cancelled: "[-]",
    blocked: "[!]",
    deferred: "[:]",
  })[status]

const formatTodoList: (todos: ReadonlyArray<Todo>) => string = todos =>
  todos.length === 0
    ? "No todos"
    : todos
        .map(todo => {
          const detail =
            todo.status === "blocked"
              ? ` — blocked: ${todo.reason}`
              : todo.status === "deferred" && todo.remindAt !== undefined
                ? ` — deferred until ${new Date(todo.remindAt).toISOString()}`
                : ""
          const replies =
            todo.replies?.map(reply => `\n    ↳ reply: ${reply}`).join("") ?? ""
          return `${todoStatusMark(todo.status)} #${todo.id}: ${todo.text}${detail}${replies}`
        })
        .join("\n")
