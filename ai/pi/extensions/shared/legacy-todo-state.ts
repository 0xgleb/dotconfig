import { Data, Effect, Option, Schema } from "effect"
import { isFibonacciEffort, type FibonacciEffort } from "./fibonacci-effort.ts"

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
  readonly parentId?: number
  readonly statusChangedAt?: number
  readonly priority?: number
  readonly effort?: FibonacciEffort
}

export type Todo =
  | (TodoBase & { readonly status: ImmediateTodoStatus })
  | (TodoBase & { readonly status: "deferred"; readonly remindAt?: number })
  | (TodoBase & { readonly status: "blocked"; readonly reason: string })

export interface TodoState {
  readonly todos: ReadonlyArray<Todo>
  readonly nextId: number
}

export class TodoInputError extends Data.TaggedError("TodoInputError")<{
  action: "list"
  message: string
  code?:
    | "reply_limit"
    | "reply_length"
    | "invalid_parent"
    | "invalid_state"
    | "invalid_priority"
    | "invalid_effort"
    | "priority_conflict"
}> {}

const validPriority = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 1

const PrioritySchema = Schema.Number.pipe(Schema.filter(validPriority))
const EffortSchema = Schema.declare(isFibonacciEffort)

const TodoSchema = Schema.Union(
  Schema.Struct({
    id: Schema.Number,
    text: Schema.String,
    effort: Schema.optionalWith(EffortSchema, { exact: true }),
    priority: Schema.optionalWith(PrioritySchema, { exact: true }),
    parentId: Schema.optionalWith(Schema.Number, { exact: true }),
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
    parentId: Schema.optionalWith(Schema.Number, { exact: true }),
    status: Schema.Literal("deferred"),
    effort: Schema.optionalWith(EffortSchema, { exact: true }),
    priority: Schema.optionalWith(PrioritySchema, { exact: true }),
    remindAt: Schema.optionalWith(Schema.Number, { exact: true }),
    replies: Schema.optionalWith(Schema.Array(Schema.String), { exact: true }),
    statusChangedAt: Schema.optionalWith(Schema.Number, { exact: true }),
  }),
  Schema.Struct({
    id: Schema.Number,
    text: Schema.String,
    parentId: Schema.optionalWith(Schema.Number, { exact: true }),
    status: Schema.Literal("blocked"),
    effort: Schema.optionalWith(EffortSchema, { exact: true }),
    priority: Schema.optionalWith(PrioritySchema, { exact: true }),
    reason: Schema.String,
    replies: Schema.optionalWith(Schema.Array(Schema.String), { exact: true }),
    statusChangedAt: Schema.optionalWith(Schema.Number, { exact: true }),
  }),
)

const TodoStateSchema = Schema.Struct({
  todos: Schema.Array(TodoSchema),
  nextId: Schema.Number,
})

export const decodeTodoState: (
  value: unknown,
) => Option.Option<TodoState> = value =>
  Schema.decodeUnknownOption(TodoStateSchema)(value)

const todoStateError = (
  state: TodoState,
  action: "list",
): TodoInputError | undefined => {
  if (
    state.todos.some(
      todo => todo.effort !== undefined && !isFibonacciEffort(todo.effort),
    )
  )
    return new TodoInputError({
      action,
      code: "invalid_effort",
      message:
        "Persisted effort must be positive safe Fibonacci points or absent",
    })
  if (
    state.todos.some(
      todo => todo.priority !== undefined && !validPriority(todo.priority),
    )
  )
    return new TodoInputError({
      action,
      code: "invalid_priority",
      message:
        "Persisted todo priority must be an assigned positive safe-integer rank or absent",
    })
  const ids = state.todos.map(todo => todo.id)
  const maxId = ids.reduce((max, id) => Math.max(max, id), 0)
  if (
    ids.some(id => !Number.isSafeInteger(id) || id < 1) ||
    new Set(ids).size !== ids.length ||
    !Number.isSafeInteger(state.nextId) ||
    state.nextId <= maxId
  ) {
    return new TodoInputError({
      action,
      code: "invalid_state",
      message:
        "Todo state requires unique positive safe-integer IDs and a nextId greater than every existing ID",
    })
  }
  const invalid = state.todos.find(todo => {
    if (todo.parentId === undefined) return false
    const parent = state.todos.find(candidate => candidate.id === todo.parentId)
    return (
      !Number.isSafeInteger(todo.parentId) ||
      todo.parentId < 1 ||
      todo.parentId === todo.id ||
      !parent ||
      parent.parentId !== undefined
    )
  })
  return invalid === undefined
    ? undefined
    : new TodoInputError({
        action,
        code: "invalid_parent",
        message: `Todo #${invalid.id} has an invalid parent; only existing root tasks can have one level of subtasks`,
      })
}

export const validateTodoState = (
  state: TodoState,
): Effect.Effect<TodoState, TodoInputError> => {
  const error = todoStateError(state, "list")
  return error ? Effect.fail(error) : Effect.succeed(state)
}
