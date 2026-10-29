import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent"
import { Data, Either, Schema } from "effect"
import { isFibonacciEffort, type TodoRequest } from "./state.ts"

export interface TodoControlResult {
  readonly isError: boolean
  readonly message: string
}

export class TodoControlError extends Data.TaggedError("TodoControlError")<{
  readonly code?: "unconfirmed"
  readonly message: string
}> {}

export type TodoControlHandler = (
  request: TodoRequest,
  ctx: ExtensionContext,
) => TodoControlResult

export const decodeTodoControl = (
  value: unknown,
): Either.Either<TodoRequest, TodoControlError> =>
  Either.mapLeft(
    Schema.decodeUnknownEither(RequestSchema, { onExcessProperty: "error" })(
      value,
    ),
    () => new TodoControlError({ message: "Malformed worker task request." }),
  )

export const requestTodoControl = (
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  request: TodoRequest,
): Either.Either<TodoControlResult, TodoControlError> => {
  let result: TodoControlResult | undefined
  let claimed = false

  const emitted = Either.try({
    try: () => {
      const preferPriorityAware = todoPriorityAvailable(pi)
      const preferEffortAware = todoEffortAvailable(pi)
      const requiresPriority =
        request.action === "priority" ||
        request.action === "priority_relative" ||
        request.action === "priority_order"
      const requiresEffort =
        request.action === "effort" ||
        (request.action === "add" && request.effort !== undefined)

      pi.events.emit(CONTROL_EVENT, {
        kind: "todo-control.v1",
        run: (
          handler: TodoControlHandler,
          capabilities?: TodoControlCapabilities,
        ) => {
          if (
            claimed ||
            ((requiresPriority || preferPriorityAware) &&
              capabilities?.priority !== true) ||
            ((requiresEffort || preferEffortAware) &&
              capabilities?.effort !== true)
          )
            return

          claimed = true
          result = handler(request, ctx)
        },
      } satisfies ControlEnvelope)
    },
    catch: () =>
      new TodoControlError({
        code: "unconfirmed",
        message:
          "Worker task result is unconfirmed; inspect its state before retrying.",
      }),
  })

  if (Either.isLeft(emitted)) return Either.left(emitted.left)

  return result === undefined
    ? Either.left(
        new TodoControlError({
          message: "The worker task handler is unavailable.",
        }),
      )
    : Either.right(result)
}

export interface TodoControlCapabilities {
  readonly priority?: true
  readonly effort?: true
}

export const todoEffortAvailable = (pi: ExtensionAPI): boolean => {
  let available = false

  pi.events.emit(CONTROL_EVENT, {
    kind: "todo-control.v1",
    run: (
      _handler: TodoControlHandler,
      capabilities?: TodoControlCapabilities,
    ) => {
      if (capabilities?.effort === true) available = true
    },
  } satisfies ControlEnvelope)

  return available
}

export const todoPriorityAvailable = (pi: ExtensionAPI): boolean => {
  let available = false

  pi.events.emit(CONTROL_EVENT, {
    kind: "todo-control.v1",
    run: (
      _handler: TodoControlHandler,
      capabilities?: TodoControlCapabilities,
    ) => {
      if (capabilities?.priority === true) available = true
    },
  } satisfies ControlEnvelope)

  return available
}

export const registerTodoControl = (
  pi: ExtensionAPI,
  handler: TodoControlHandler,
  capabilities: TodoControlCapabilities = {},
): (() => void) =>
  pi.events.on(CONTROL_EVENT, (value: unknown) => {
    if (controlEnvelope(value)) value.run(handler, capabilities)
  })

export const todoControlAvailable = (pi: ExtensionAPI): boolean => {
  let available = false

  pi.events.emit(CONTROL_EVENT, {
    kind: "todo-control.v1",
    run: () => {
      available = true
    },
  } satisfies ControlEnvelope)

  return available
}

interface ControlEnvelope {
  readonly kind: "todo-control.v1"
  readonly run: (
    handler: TodoControlHandler,
    capabilities?: TodoControlCapabilities,
  ) => void
}

const CONTROL_EVENT = "pi:manager-todo-control.v1"

const controlEnvelope = (value: unknown): value is ControlEnvelope =>
  typeof value === "object" &&
  value !== null &&
  "kind" in value &&
  value.kind === "todo-control.v1" &&
  "run" in value &&
  typeof value.run === "function"

const optionalId = Schema.optionalWith(Schema.Number, { exact: true })
const optionalText = Schema.optionalWith(Schema.String, { exact: true })
const positiveSafeInteger = Schema.Number.pipe(
  Schema.filter(value => Number.isSafeInteger(value) && value >= 1),
)
const effortPoints = Schema.Number.pipe(Schema.filter(isFibonacciEffort))

const RequestSchema = Schema.Union(
  Schema.Struct({ action: Schema.Literal("list") }),
  Schema.Struct({
    action: Schema.Literal("priority_relative"),
    id: positiveSafeInteger,
    referenceId: positiveSafeInteger,
    position: Schema.Literal("above", "below"),
  }),
  Schema.Struct({
    action: Schema.Literal("priority_order"),
    ids: Schema.Array(positiveSafeInteger).pipe(
      Schema.filter(ids => ids.length > 0 && new Set(ids).size === ids.length),
    ),
  }),
  Schema.Struct({
    action: Schema.Literal("effort"),
    id: positiveSafeInteger,
    effort: Schema.NullOr(effortPoints),
  }),
  Schema.Struct({
    action: Schema.Literal("priority"),
    id: positiveSafeInteger,
    priority: Schema.NullOr(positiveSafeInteger),
  }),
  Schema.Struct({
    action: Schema.Literal("add"),
    text: optionalText,
    parentId: optionalId,
    effort: Schema.optionalWith(effortPoints, { exact: true }),
  }),
  Schema.Struct({ action: Schema.Literal("toggle"), id: optionalId }),
  Schema.Struct({
    action: Schema.Literal("status"),
    id: optionalId,
    status: Schema.optionalWith(
      Schema.Literal(
        "pending",
        "in_progress",
        "in_review",
        "completed",
        "cancelled",
        "deferred",
      ),
      { exact: true },
    ),
    remindAt: optionalText,
  }),
  Schema.Struct({
    action: Schema.Literal("block"),
    id: optionalId,
    reason: optionalText,
  }),
  Schema.Struct({
    action: Schema.Literal("reply"),
    id: optionalId,
    text: optionalText,
  }),
  Schema.Struct({ action: Schema.Literal("unblock"), id: optionalId }),
  Schema.Struct({ action: Schema.Literal("clear") }),
)
