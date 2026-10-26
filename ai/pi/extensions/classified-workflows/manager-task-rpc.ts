import { Effect, Either } from "effect"
import type { ManagerPairScope } from "./manager-pair-protocol.ts"
import { ManagerSessionError } from "./manager-session-core.ts"
import type {
  ManagerTaskAuthority,
  ManagerTaskOperation,
  ManagerTaskResult,
} from "./manager-task-protocol.ts"

export const MAX_MANAGER_TASK_FRAME_BYTES = 250_000
export const MAX_MANAGER_TASK_REQUEST_BYTES = 64_000
export interface ManagerTaskServer {
  readonly close: Effect.Effect<void, ManagerSessionError>
}
export interface ManagerTaskServerInput {
  readonly directory: string
  readonly authority: ManagerTaskAuthority
  readonly revision: () => Either.Either<string, ManagerSessionError>
  readonly invoke: (
    operation: ManagerTaskOperation,
  ) => Either.Either<string, ManagerSessionError>
  readonly now?: () => number
}
export interface ManagerTaskCallInput {
  readonly directory: string
  readonly scope: ManagerPairScope
  readonly authority: ManagerTaskAuthority
  readonly operation: ManagerTaskOperation
  readonly timeoutMs: number
  readonly signal?: AbortSignal
}
export const startManagerTaskServer = (
  _input: ManagerTaskServerInput,
): Effect.Effect<ManagerTaskServer, ManagerSessionError> =>
  Effect.fail(
    new ManagerSessionError({
      code: "unavailable",
      message: "Direct task endpoint is unavailable.",
    }),
  )
export const callManagerTask = (
  _input: ManagerTaskCallInput,
): Effect.Effect<ManagerTaskResult, ManagerSessionError> =>
  Effect.fail(
    new ManagerSessionError({
      code: "unavailable",
      message: "Direct task endpoint is unavailable.",
    }),
  )
