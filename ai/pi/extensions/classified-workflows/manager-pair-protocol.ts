import { isAbsolute } from "node:path"
import { Either } from "effect"
import { ManagerSessionError } from "./manager-session-core.ts"

export interface ManagerPairScope {
  readonly workerSessionId: string
  readonly cwd: string
}

export interface ManagerContextSnapshot extends ManagerPairScope {
  readonly version: 1
  readonly observedAt: number
  readonly priorityRevision: string
  readonly data: Readonly<Record<string, unknown>>
}

export interface ManagerPriorityReceipt {
  readonly version: 1
  readonly id: string
  readonly status: "started" | "completed" | "failed" | "unconfirmed"
  readonly message: string
}

export const decodeManagerContext = (
  value: unknown,
  scope: ManagerPairScope,
): Either.Either<ManagerContextSnapshot, ManagerSessionError> => {
  if (
    !validScope(scope) ||
    !record(value) ||
    value.version !== 1 ||
    value.workerSessionId !== scope.workerSessionId ||
    value.cwd !== scope.cwd ||
    typeof value.observedAt !== "number" ||
    !Number.isSafeInteger(value.observedAt) ||
    value.observedAt < 0 ||
    !identifier(value.priorityRevision) ||
    !record(value.data) ||
    !onlyKeys(value, [
      "version",
      "workerSessionId",
      "cwd",
      "observedAt",
      "priorityRevision",
      "data",
    ])
  ) {
    return invalid(
      "protocol",
      "Manager context has malformed fields or belongs to another worker.",
    )
  }

  return Either.right({
    ...scope,
    version: 1,
    observedAt: value.observedAt,
    priorityRevision: value.priorityRevision,
    data: value.data,
  })
}

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const identifier = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/u.test(value)

const validScope = (value: ManagerPairScope): boolean =>
  record(value) &&
  identifier(value.workerSessionId) &&
  typeof value.cwd === "string" &&
  isAbsolute(value.cwd) &&
  value.cwd.length <= 4000 &&
  !/[\u0000-\u001f\u007f]/u.test(value.cwd)

const onlyKeys = (
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean => Object.keys(value).every(key => keys.includes(key))

const invalid = (code: ManagerSessionError["code"], message: string) =>
  Either.left(new ManagerSessionError({ code, message }))

export {
  identifier as isManagerProtocolIdentifier,
  validScope as isManagerPairScope,
}
