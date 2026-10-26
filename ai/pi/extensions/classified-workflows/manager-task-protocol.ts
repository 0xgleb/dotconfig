import { Either, Schema } from "effect"
import { createHmac, timingSafeEqual } from "node:crypto"
import { isAbsolute } from "node:path"
import { decodeTodoControl } from "../todo/control.ts"
import type { TodoRequest } from "../todo/state.ts"
import type { ManagerPairScope } from "./manager-pair-protocol.ts"
import { ManagerSessionError } from "./manager-session-core.ts"

export type ManagerTaskOperation =
  | { readonly kind: "todo"; readonly request: TodoRequest }
  | { readonly kind: "priorities"; readonly text: string }

export interface ManagerTaskHello extends ManagerPairScope {
  readonly version: 1
  readonly kind: "task-hello"
  readonly nonce: string
  readonly revision: string
  readonly expiresAt: number
  readonly signature: string
}
export interface ManagerTaskCommand extends ManagerPairScope {
  readonly version: 1
  readonly kind: "task-command"
  readonly id: string
  readonly nonce: string
  readonly revision: string
  readonly expiresAt: number
  readonly operation: ManagerTaskOperation
  readonly signature: string
}
export interface ManagerTaskResult {
  readonly outcome: "completed" | "failed" | "unconfirmed"
  readonly message: string
}
export interface ManagerTaskResponse extends ManagerPairScope {
  readonly version: 1
  readonly kind: "task-result"
  readonly id: string
  readonly nonce: string
  readonly result: ManagerTaskResult
  readonly signature: string
}
export interface ManagerTaskAuthority {
  readonly hello: (
    nonce: string,
    revision: string,
    expiresAt: number,
  ) => Either.Either<ManagerTaskHello, ManagerSessionError>
  readonly readHello: (
    value: unknown,
  ) => Either.Either<ManagerTaskHello, ManagerSessionError>
  readonly command: (
    hello: ManagerTaskHello,
    id: string,
    operation: ManagerTaskOperation,
    expiresAt: number,
  ) => Either.Either<ManagerTaskCommand, ManagerSessionError>
  readonly readCommand: (
    value: unknown,
    hello: ManagerTaskHello,
    revision: string,
    now: number,
  ) => Either.Either<ManagerTaskCommand, ManagerSessionError>
  readonly response: (
    command: Pick<ManagerTaskCommand, "id" | "nonce">,
    result: ManagerTaskResult,
  ) => Either.Either<ManagerTaskResponse, ManagerSessionError>
  readonly readResponse: (
    value: unknown,
    command: ManagerTaskCommand,
  ) => Either.Either<ManagerTaskResponse, ManagerSessionError>
}

const identifier = Schema.String.pipe(
  Schema.pattern(/^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/u),
)
const instant = Schema.Number.pipe(
  Schema.filter(value => Number.isSafeInteger(value) && value >= 0),
)
const signatureSchema = Schema.String.pipe(Schema.pattern(/^[0-9a-f]{64}$/u))
const scopeFields = { workerSessionId: identifier, cwd: Schema.String }
const helloFields = {
  version: Schema.Literal(1),
  kind: Schema.Literal("task-hello"),
  ...scopeFields,
  nonce: identifier,
  revision: identifier,
  expiresAt: instant,
}
const commandFields = {
  version: Schema.Literal(1),
  kind: Schema.Literal("task-command"),
  ...scopeFields,
  id: identifier,
  nonce: identifier,
  revision: identifier,
  expiresAt: instant,
  operation: Schema.Unknown,
}
const resultSchema = Schema.Struct({
  outcome: Schema.Literal("completed", "failed", "unconfirmed"),
  message: Schema.String,
})
const responseFields = {
  version: Schema.Literal(1),
  kind: Schema.Literal("task-result"),
  ...scopeFields,
  id: identifier,
  nonce: identifier,
  result: resultSchema,
}
const helloSchema = Schema.Struct({
  ...helloFields,
  signature: signatureSchema,
})
const commandSchema = Schema.Struct({
  ...commandFields,
  signature: signatureSchema,
})
const responseSchema = Schema.Struct({
  ...responseFields,
  signature: signatureSchema,
})
const operationSchema = Schema.Union(
  Schema.Struct({ kind: Schema.Literal("todo"), request: Schema.Unknown }),
  Schema.Struct({
    kind: Schema.Literal("priorities"),
    text: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(4096)),
  }),
)
const protocolError = () =>
  new ManagerSessionError({
    code: "protocol",
    message: "Malformed direct manager task protocol.",
  })
const decodeOperation = (
  value: unknown,
): Either.Either<ManagerTaskOperation, ManagerSessionError> =>
  Either.flatMap(
    Either.mapLeft(
      Schema.decodeUnknownEither(operationSchema, {
        onExcessProperty: "error",
      })(value),
      protocolError,
    ),
    (operation): Either.Either<ManagerTaskOperation, ManagerSessionError> =>
      operation.kind === "priorities"
        ? Either.right(operation)
        : Either.map(
            Either.mapLeft(decodeTodoControl(operation.request), protocolError),
            request => ({ kind: "todo" as const, request }),
          ),
  )

export const createManagerTaskAuthority = (
  scope: ManagerPairScope,
  readCapability: () => Either.Either<string, ManagerSessionError>,
): ManagerTaskAuthority => {
  const scoped = (value: ManagerPairScope) =>
    value.workerSessionId === scope.workerSessionId && value.cwd === scope.cwd
  const mac = (body: unknown): Either.Either<string, ManagerSessionError> =>
    Either.gen(function* () {
      if (!isAbsolute(scope.cwd) || /[\u0000-\u001f\u007f]/u.test(scope.cwd))
        return yield* Either.left(protocolError())
      const capability = yield* readCapability()
      if (!/^[0-9a-f]{64}$/u.test(capability))
        return yield* Either.left(
          new ManagerSessionError({
            code: "unsafe_state",
            message: "Invalid private manager task authority.",
          }),
        )
      return yield* Either.try({
        try: () =>
          createHmac("sha256", capability)
            .update("manager-task-rpc.v1\n")
            .update(JSON.stringify(body))
            .digest("hex"),
        catch: () =>
          new ManagerSessionError({
            code: "io",
            message: "Task protocol authentication failed.",
          }),
      })
    })
  const authenticate = (body: unknown, signature: string) =>
    Either.gen(function* () {
      const expected = yield* mac(body)
      const matches = yield* Either.try({
        try: () =>
          timingSafeEqual(
            Buffer.from(signature, "hex"),
            Buffer.from(expected, "hex"),
          ),
        catch: () => protocolError(),
      })
      if (!matches)
        return yield* Either.left(
          new ManagerSessionError({
            code: "unauthorized",
            message: "Direct task authentication failed.",
          }),
        )
    })
  const readHello: ManagerTaskAuthority["readHello"] = value =>
    Either.gen(function* () {
      const decoded = yield* Either.mapLeft(
        Schema.decodeUnknownEither(helloSchema, { onExcessProperty: "error" })(
          value,
        ),
        protocolError,
      )
      if (!scoped(decoded))
        return yield* Either.left(
          new ManagerSessionError({
            code: "unauthorized",
            message: "Task endpoint belongs to another worker.",
          }),
        )
      const { signature, ...body } = decoded
      yield* authenticate(body, signature)
      return decoded
    })
  return {
    hello: (nonce, revision, expiresAt) =>
      Either.gen(function* () {
        const body = yield* Either.mapLeft(
          Schema.decodeUnknownEither(Schema.Struct(helloFields))({
            version: 1,
            kind: "task-hello",
            ...scope,
            nonce,
            revision,
            expiresAt,
          }),
          protocolError,
        )
        const signature = yield* mac(body)
        return { ...body, signature }
      }),
    readHello,
    command: (hello, id, operation, expiresAt) =>
      Either.gen(function* () {
        yield* readHello(hello)
        const validOperation = yield* decodeOperation(operation)
        const body = yield* Either.mapLeft(
          Schema.decodeUnknownEither(Schema.Struct(commandFields))({
            version: 1,
            kind: "task-command",
            ...scope,
            id,
            nonce: hello.nonce,
            revision: hello.revision,
            expiresAt,
            operation: validOperation,
          }),
          protocolError,
        )
        if (expiresAt > hello.expiresAt)
          return yield* Either.left(protocolError())
        const canonical = { ...body, operation: validOperation }
        const signature = yield* mac(canonical)
        return { ...canonical, signature }
      }),
    readCommand: (value, hello, revision, now) =>
      Either.gen(function* () {
        const decoded = yield* Either.mapLeft(
          Schema.decodeUnknownEither(commandSchema, {
            onExcessProperty: "error",
          })(value),
          protocolError,
        )
        const operation = yield* decodeOperation(decoded.operation)
        if (!scoped(decoded) || decoded.nonce !== hello.nonce)
          return yield* Either.left(
            new ManagerSessionError({
              code: "unauthorized",
              message: "Task command does not match this worker connection.",
            }),
          )
        const { signature, ...body } = decoded
        const canonical = { ...body, operation }
        yield* authenticate(canonical, signature)
        if (
          !Number.isSafeInteger(now) ||
          now < 0 ||
          decoded.expiresAt <= now ||
          decoded.expiresAt > hello.expiresAt ||
          hello.expiresAt <= now ||
          decoded.revision !== revision ||
          decoded.revision !== hello.revision
        )
          return yield* Either.left(
            new ManagerSessionError({
              code: "stale_revision",
              message: "Task scope or deadline changed before execution.",
            }),
          )
        return { ...canonical, signature }
      }),
    response: (command, result) =>
      Either.gen(function* () {
        const body = yield* Either.mapLeft(
          Schema.decodeUnknownEither(Schema.Struct(responseFields))({
            version: 1,
            kind: "task-result",
            ...scope,
            id: command.id,
            nonce: command.nonce,
            result,
          }),
          protocolError,
        )
        const signature = yield* mac(body)
        return { ...body, signature }
      }),
    readResponse: (value, command) =>
      Either.gen(function* () {
        const decoded = yield* Either.mapLeft(
          Schema.decodeUnknownEither(responseSchema, {
            onExcessProperty: "error",
          })(value),
          protocolError,
        )
        if (
          !scoped(decoded) ||
          decoded.id !== command.id ||
          decoded.nonce !== command.nonce
        )
          return yield* Either.left(
            new ManagerSessionError({
              code: "unauthorized",
              message: "Task result does not match this worker call.",
            }),
          )
        const { signature, ...body } = decoded
        yield* authenticate(body, signature)
        return decoded
      }),
  }
}
