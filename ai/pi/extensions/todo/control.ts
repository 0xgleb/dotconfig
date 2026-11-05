import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent"
import { Data, Either } from "effect"
import type { TodoRequest } from "./state.ts"

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

const unavailable = (): TodoControlError =>
  new TodoControlError({ message: "Legacy task control is unavailable." })

export const decodeTodoControl = (
  _value: unknown,
): Either.Either<TodoRequest, TodoControlError> => Either.left(unavailable())

export const requestTodoControl = (
  _pi: ExtensionAPI,
  _ctx: ExtensionContext,
  _request: TodoRequest,
): Either.Either<TodoControlResult, TodoControlError> =>
  Either.left(unavailable())

export interface TodoControlCapabilities {
  readonly priority?: true
  readonly effort?: true
}

export const todoEffortAvailable = (_pi: ExtensionAPI): boolean => false

export const todoPriorityAvailable = (_pi: ExtensionAPI): boolean => false

export const registerTodoControl =
  (
    _pi: ExtensionAPI,
    _handler: TodoControlHandler,
    _capabilities: TodoControlCapabilities = {},
  ): (() => void) =>
  () => {}

export const todoControlAvailable = (_pi: ExtensionAPI): boolean => false
