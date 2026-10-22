import { createHmac, timingSafeEqual } from "node:crypto"
import { isAbsolute } from "node:path"
import { Either } from "effect"
import { ManagerSessionError } from "./manager-session-core.ts"

export interface ManagerPairScope {
  readonly workerSessionId: string
  readonly cwd: string
}

export interface ManagerPriorityCommand extends ManagerPairScope {
  readonly version: 1
  readonly id: string
  readonly expectedRevision: string
  readonly text: string
  readonly signature: string
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
  readonly status: "completed" | "failed"
  readonly message: string
}

export const signManagerPriority = (
  scope: ManagerPairScope,
  id: string,
  revision: string,
  text: string,
  capability: string,
): Either.Either<ManagerPriorityCommand, ManagerSessionError> => {
  if (
    !validScope(scope) ||
    !identifier(id) ||
    !identifier(revision) ||
    !commandText(text) ||
    !secret(capability)
  ) {
    return invalid(
      "invalid_input",
      "Manager priority command has invalid scope or fields.",
    )
  }

  return Either.map(
    signature(scope, id, revision, text, capability),
    signed => ({
      ...scope,
      version: 1,
      id,
      expectedRevision: revision,
      text,
      signature: signed,
    }),
  )
}

export const verifyManagerPriority = (
  value: unknown,
  scope: ManagerPairScope,
  revision: string,
  capability: string,
): Either.Either<ManagerPriorityCommand, ManagerSessionError> => {
  if (!validScope(scope) || !identifier(revision) || !secret(capability)) {
    return invalid(
      "invalid_input",
      "Manager priority verifier has invalid scope.",
    )
  }

  if (
    !record(value) ||
    value.version !== 1 ||
    !identifier(value.id) ||
    !identifier(value.expectedRevision) ||
    !commandText(value.text) ||
    !secret(value.signature) ||
    !onlyKeys(value, [
      "version",
      "id",
      "workerSessionId",
      "cwd",
      "expectedRevision",
      "text",
      "signature",
    ])
  ) {
    return invalid("protocol", "Malformed manager priority command.")
  }

  if (
    value.workerSessionId !== scope.workerSessionId ||
    value.cwd !== scope.cwd
  ) {
    return invalid(
      "unauthorized",
      "Manager priority command targets another worker.",
    )
  }

  const expected = signature(
    scope,
    value.id,
    value.expectedRevision,
    value.text,
    capability,
  )
  if (Either.isLeft(expected)) return Either.left(expected.left)

  const authenticated = Either.try({
    try: () =>
      timingSafeEqual(
        Buffer.from(expected.right, "hex"),
        Buffer.from(value.signature, "hex"),
      ),
    catch: () =>
      new ManagerSessionError({
        code: "io",
        message: "Manager signature verification failed.",
      }),
  })
  if (Either.isLeft(authenticated)) return Either.left(authenticated.left)
  if (!authenticated.right)
    return invalid("unauthorized", "Manager priority authentication failed.")

  if (value.expectedRevision !== revision) {
    return invalid(
      "stale_revision",
      "Worker priorities changed; inspect the current order before applying another command.",
    )
  }

  return Either.right({
    ...scope,
    version: 1,
    id: value.id,
    expectedRevision: value.expectedRevision,
    text: value.text,
    signature: value.signature,
  })
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

const secret = (value: unknown): value is string =>
  typeof value === "string" && /^[0-9a-f]{64}$/u.test(value)

const commandText = (value: unknown): value is string =>
  typeof value === "string" &&
  value.trim().length > 0 &&
  value.length <= 1000 &&
  !/[\u0000-\u001f\u007f]/u.test(value)

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

const signature = (
  scope: ManagerPairScope,
  id: string,
  revision: string,
  text: string,
  capability: string,
): Either.Either<string, ManagerSessionError> =>
  Either.try({
    try: () =>
      createHmac("sha256", capability)
        .update(
          JSON.stringify({
            version: 1,
            workerSessionId: scope.workerSessionId,
            cwd: scope.cwd,
            id,
            expectedRevision: revision,
            text,
          }),
        )
        .digest("hex"),
    catch: () =>
      new ManagerSessionError({
        code: "io",
        message: "Manager command signing failed.",
      }),
  })
