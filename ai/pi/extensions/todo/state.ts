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

declare const fibonacciEffortBrand: unique symbol
export type FibonacciEffort = number & {
  readonly [fibonacciEffortBrand]: true
}

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

export type TodoRequest =
  | { readonly action: "list" }
  | {
      readonly action: "add"
      readonly text?: string
      readonly parentId?: number
      readonly effort?: number
    }
  | {
      readonly action: "effort"
      readonly id?: number
      readonly effort?: number | null
    }
  | {
      readonly action: "priority"
      readonly id?: number
      readonly priority?: number | null
    }
  | {
      readonly action: "priority_relative"
      readonly id?: number
      readonly referenceId?: number
      readonly position?: "above" | "below"
    }
  | { readonly action: "priority_order"; readonly ids?: ReadonlyArray<number> }
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
  | {
      readonly action: "add"
      readonly text: string
      readonly parentId?: number
      readonly effort?: FibonacciEffort
    }
  | {
      readonly action: "effort"
      readonly id: number
      readonly effort: FibonacciEffort | null
    }
  | {
      readonly action: "priority"
      readonly id: number
      readonly priority: number | null
    }
  | {
      readonly action: "priority_relative"
      readonly id: number
      readonly referenceId: number
      readonly position: "above" | "below"
    }
  | { readonly action: "priority_order"; readonly ids: ReadonlyArray<number> }
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
  code?:
    | "reply_limit"
    | "reply_length"
    | "invalid_parent"
    | "invalid_state"
    | "invalid_priority"
    | "invalid_effort"
    | "priority_conflict"
}> {}

export const MAX_TODOS_PER_PRIORITY = 1
export const MAX_TODO_REPLIES = 3
export const MAX_TODO_REPLY_LENGTH = 300

export const isFibonacciEffort = (value: unknown): value is FibonacciEffort => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1)
    return false
  if (value === 1) return true
  let previous = 1
  let current = 2
  while (current < value) {
    if (current > Number.MAX_SAFE_INTEGER - previous) return false
    const next = previous + current
    previous = current
    current = next
  }
  return current === value
}

export class TodoNotFoundError extends Data.TaggedError("TodoNotFoundError")<{
  action:
    | "toggle"
    | "status"
    | "block"
    | "reply"
    | "unblock"
    | "priority"
    | "effort"
    | "priority_relative"
    | "priority_order"
  message: string
}> {}

export const emptyTodoState: TodoState = { todos: [], nextId: 1 }

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

const TodoActionSchema = Schema.Literal(
  "priority_relative",
  "priority_order",
  "effort",
  "priority",
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

const todoStateError = (
  state: TodoState,
  action: TodoAction["action"],
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

const todoWithStatus: (
  todo: Todo,
  status: SettableTodoStatus,
  now?: number,
  remindAt?: number,
) => Todo = (todo, status, now, remindAt) => {
  const base: TodoBase = {
    id: todo.id,
    text: todo.text,
    ...(todo.priority === undefined ? {} : { priority: todo.priority }),
    ...(todo.effort === undefined ? {} : { effort: todo.effort }),
    ...(todo.parentId === undefined ? {} : { parentId: todo.parentId }),
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

const validPriorityOrder = (value: unknown): value is ReadonlyArray<number> =>
  Array.isArray(value) &&
  value.length > 0 &&
  Array.from(value).every(validPriority) &&
  new Set(value).size === value.length

const applyPriorityOrder = (
  state: TodoState,
  ids: ReadonlyArray<number>,
  action: "priority_order" | "priority_relative",
): Effect.Effect<TodoTransition, TodoInputError | TodoNotFoundError> => {
  if (!validPriorityOrder(ids))
    return Effect.fail(
      new TodoInputError({
        action,
        code: "invalid_priority",
        message:
          "Priority order requires a nonempty list of unique positive safe-integer todo IDs",
      }),
    )
  const existing = new Set(state.todos.map(todo => todo.id))
  const missing = ids.find(id => !existing.has(id))
  if (missing !== undefined)
    return Effect.fail(
      new TodoNotFoundError({ action, message: `Todo #${missing} not found` }),
    )
  const ranks = new Map(ids.map((id, index) => [id, index + 1]))
  if (
    state.todos.some(todo => todo.priority !== undefined && !ranks.has(todo.id))
  )
    return Effect.fail(
      new TodoInputError({
        action,
        code: "invalid_priority",
        message:
          "Priority order must include every currently assigned todo; use priority=null to unassign explicitly",
      }),
    )
  return Effect.succeed({
    action,
    state: {
      nextId: state.nextId,
      todos: state.todos.map(todo => {
        const priority = ranks.get(todo.id)
        return priority === undefined ? todo : { ...todo, priority }
      }),
    },
    message: `Ordered ${ids.length} todos with one assigned task per rank: ${ids.map((id, index) => `#${id}=${index + 1}`).join(", ")}`,
  })
}

export const transitionTodoState: (
  state: TodoState,
  action: TodoAction,
  now?: number,
) => Effect.Effect<TodoTransition, TodoNotFoundError | TodoInputError> = (
  state,
  action,
  now,
) => {
  const stateError = todoStateError(state, action.action)
  if (stateError) return Effect.fail(stateError)
  switch (action.action) {
    case "priority_order":
      return applyPriorityOrder(state, action.ids, action.action)
    case "priority_relative": {
      if (
        !validPriority(action.id) ||
        !validPriority(action.referenceId) ||
        (action.position !== "above" && action.position !== "below") ||
        action.id === action.referenceId
      )
        return Effect.fail(
          new TodoInputError({
            action: action.action,
            code: "invalid_priority",
            message:
              "Relative priority requires distinct positive safe-integer todo IDs and position above or below",
          }),
        )
      const target = state.todos.find(todo => todo.id === action.id)
      const reference = state.todos.find(todo => todo.id === action.referenceId)
      if (!target || !reference)
        return Effect.fail(
          new TodoNotFoundError({
            action: action.action,
            message: `Todo #${!target ? action.id : action.referenceId} not found`,
          }),
        )
      if (reference.priority === undefined)
        return Effect.fail(
          new TodoInputError({
            action: action.action,
            code: "invalid_priority",
            message: "Relative priority requires an assigned reference task",
          }),
        )
      const ordered = state.todos
        .flatMap(todo =>
          todo.priority === undefined || todo.id === target.id
            ? []
            : [{ id: todo.id, rank: todo.priority }],
        )
        .toSorted((left, right) => left.rank - right.rank)
        .map(todo => todo.id)
      const insertion =
        ordered.indexOf(reference.id) + (action.position === "below" ? 1 : 0)
      return applyPriorityOrder(
        state,
        [
          ...ordered.slice(0, insertion),
          target.id,
          ...ordered.slice(insertion),
        ],
        action.action,
      )
    }
    case "effort": {
      if (action.effort !== null && !isFibonacciEffort(action.effort))
        return Effect.fail(
          new TodoInputError({
            action: "effort",
            code: "invalid_effort",
            message:
              "effort must be positive safe Fibonacci points, or null to clear",
          }),
        )
      const target = state.todos.find(todo => todo.id === action.id)
      if (!target)
        return Effect.fail(
          new TodoNotFoundError({
            action: "effort",
            message: `Todo #${action.id} not found`,
          }),
        )
      const { effort: _effort, ...unestimated } = target
      const replacement: Todo =
        action.effort === null
          ? unestimated
          : { ...target, effort: action.effort }
      return Effect.succeed({
        action: "effort",
        state: {
          todos: state.todos.map(todo =>
            todo.id === target.id ? replacement : todo,
          ),
          nextId: state.nextId,
        },
        message: `Todo #${target.id} effort ${action.effort === null ? "unassigned" : `${action.effort} points`}`,
      })
    }
    case "priority": {
      if (action.priority !== null && !validPriority(action.priority))
        return Effect.fail(
          new TodoInputError({
            action: "priority",
            code: "invalid_priority",
            message:
              "priority must be a positive safe-integer rank, or null to unassign",
          }),
        )
      const target = state.todos.find(todo => todo.id === action.id)
      if (!target)
        return Effect.fail(
          new TodoNotFoundError({
            action: "priority",
            message: `Todo #${action.id} not found`,
          }),
        )
      if (
        action.priority !== null &&
        state.todos.filter(
          todo => todo.id !== target.id && todo.priority === action.priority,
        ).length >= MAX_TODOS_PER_PRIORITY
      )
        return Effect.fail(
          new TodoInputError({
            action: "priority",
            code: "priority_conflict",
            message: `Rank ${action.priority} is occupied (limit ${MAX_TODOS_PER_PRIORITY}); use priority_order or priority_relative to reorder atomically`,
          }),
        )
      const { priority: _priority, ...unassigned } = target
      const replacement: Todo =
        action.priority === null
          ? unassigned
          : { ...target, priority: action.priority }
      return Effect.succeed({
        action: "priority",
        state: {
          todos: state.todos.map(todo =>
            todo.id === target.id ? replacement : todo,
          ),
          nextId: state.nextId,
        },
        message: `Todo #${target.id} priority ${action.priority === null ? "unassigned" : action.priority}`,
      })
    }
    case "list":
      return Effect.succeed({
        action: "list",
        state,
        message: formatTodoList(state.todos),
      })

    case "add": {
      if (state.nextId >= Number.MAX_SAFE_INTEGER) {
        return Effect.fail(
          new TodoInputError({
            action: "add",
            code: "invalid_state",
            message: "Cannot allocate another safe-integer todo ID",
          }),
        )
      }
      if (action.effort !== undefined && !isFibonacciEffort(action.effort))
        return Effect.fail(
          new TodoInputError({
            action: "add",
            code: "invalid_effort",
            message: "effort must be positive safe Fibonacci points",
          }),
        )
      if (action.parentId !== undefined) {
        const parent = state.todos.find(todo => todo.id === action.parentId)
        if (
          !Number.isSafeInteger(action.parentId) ||
          !parent ||
          parent.parentId !== undefined ||
          action.parentId === state.nextId
        ) {
          return Effect.fail(
            new TodoInputError({
              action: "add",
              code: "invalid_parent",
              message:
                "A subtask requires an existing root task; only one level of subtasks is allowed",
            }),
          )
        }
      }
      const todo: Todo = {
        id: state.nextId,
        text: action.text,
        status: "pending",
        ...(action.effort === undefined ? {} : { effort: action.effort }),
        ...(action.parentId === undefined ? {} : { parentId: action.parentId }),
      }
      return Effect.succeed({
        action: "add",
        state: { todos: [...state.todos, todo], nextId: state.nextId + 1 },
        message: `Added todo ${todoIdentityLabel(todo)}: ${todo.text}`,
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
        ...(target.priority === undefined ? {} : { priority: target.priority }),
        ...(target.effort === undefined ? {} : { effort: target.effort }),
        ...(target.parentId === undefined ? {} : { parentId: target.parentId }),
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
      if (action.text.length > MAX_TODO_REPLY_LENGTH) {
        return Effect.fail(
          new TodoInputError({
            action: "reply",
            code: "reply_length",
            message: `Replies must be at most ${MAX_TODO_REPLY_LENGTH} characters; put executable work in tasks or subtasks`,
          }),
        )
      }
      if ((target.replies?.length ?? 0) >= MAX_TODO_REPLIES) {
        return Effect.fail(
          new TodoInputError({
            action: "reply",
            code: "reply_limit",
            message: `Todo #${target.id} has reached ${MAX_TODO_REPLIES} replies; restructure the work into executable tasks or one-level subtasks instead of appending another update`,
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
    case "priority_order":
      return validPriorityOrder(request.ids)
        ? Effect.succeed({ action: "priority_order", ids: request.ids })
        : Effect.fail(
            new TodoInputError({
              action: "priority_order",
              code: "invalid_priority",
              message:
                "Priority order requires a nonempty list of unique positive safe-integer todo IDs",
            }),
          )
    case "priority_relative":
      if (
        !validPriority(request.id) ||
        !validPriority(request.referenceId) ||
        request.id === request.referenceId ||
        (request.position !== "above" && request.position !== "below")
      )
        return Effect.fail(
          new TodoInputError({
            action: "priority_relative",
            code: "invalid_priority",
            message:
              "Relative priority requires distinct positive safe-integer todo IDs and position above or below",
          }),
        )
      return Effect.succeed({
        action: "priority_relative",
        id: request.id,
        referenceId: request.referenceId,
        position: request.position,
      })
    case "effort":
      if (
        request.id === undefined ||
        !Number.isSafeInteger(request.id) ||
        request.id < 1
      )
        return Effect.fail(
          new TodoInputError({
            action: "effort",
            message: "effort requires a positive safe-integer todo id",
          }),
        )
      if (request.effort !== null && !isFibonacciEffort(request.effort))
        return Effect.fail(
          new TodoInputError({
            action: "effort",
            code: "invalid_effort",
            message:
              "effort must be positive safe Fibonacci points, or null to clear",
          }),
        )
      return Effect.succeed({
        action: "effort",
        id: request.id,
        effort: request.effort,
      })
    case "priority":
      if (
        request.id === undefined ||
        !Number.isSafeInteger(request.id) ||
        request.id < 1
      )
        return Effect.fail(
          new TodoInputError({
            action: "priority",
            message: "priority requires a positive safe-integer todo id",
          }),
        )
      if (request.priority !== null && !validPriority(request.priority))
        return Effect.fail(
          new TodoInputError({
            action: "priority",
            code: "invalid_priority",
            message:
              "priority must be a positive safe-integer rank, or null to unassign",
          }),
        )
      return Effect.succeed({
        action: "priority",
        id: request.id,
        priority: request.priority,
      })
    case "list":
      return Effect.succeed(request)
    case "add": {
      if (request.effort !== undefined && !isFibonacciEffort(request.effort))
        return Effect.fail(
          new TodoInputError({
            action: "add",
            code: "invalid_effort",
            message: "effort must be positive safe Fibonacci points",
          }),
        )
      const text = request.text?.trim()
      if (
        request.parentId !== undefined &&
        (!Number.isSafeInteger(request.parentId) || request.parentId < 1)
      ) {
        return Effect.fail(
          new TodoInputError({
            action: "add",
            code: "invalid_parent",
            message: "parentId must identify an existing root task",
          }),
        )
      }
      return text
        ? Effect.succeed({
            action: "add",
            text,
            ...(request.effort === undefined ? {} : { effort: request.effort }),
            ...(request.parentId === undefined
              ? {}
              : { parentId: request.parentId }),
          })
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
      if (text && text.length > MAX_TODO_REPLY_LENGTH) {
        return Effect.fail(
          new TodoInputError({
            action: "reply",
            code: "reply_length",
            message: `Replies must be at most ${MAX_TODO_REPLY_LENGTH} characters`,
          }),
        )
      }
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

export const todoIdentityLabel = (todo: Todo): string =>
  todo.parentId === undefined
    ? `#${todo.id}`
    : `#${todo.id} (subtask of #${todo.parentId})`

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
          return `${todoStatusMark(todo.status)} ${todoIdentityLabel(todo)}: ${todo.text}${todo.priority === undefined ? "" : ` [priority ${todo.priority}]`}${todo.effort === undefined ? "" : ` [effort ${todo.effort} points]`}${detail}${replies}`
        })
        .join("\n")
