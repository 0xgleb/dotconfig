import { randomBytes, randomUUID } from "node:crypto"
import {
  constants,
  openSync,
  closeSync,
  fstatSync,
  lstatSync,
  readFileSync,
  writeFileSync,
  renameSync,
  unlinkSync,
  mkdirSync,
  existsSync,
  readdirSync,
} from "node:fs"
import { isAbsolute, join } from "node:path"
import { Either } from "effect"
import {
  decodeManagerContext,
  signManagerPriority,
  verifyManagerPriority,
  signManagerTodo,
  verifyManagerTodo,
  type ManagerPairScope,
  type ManagerContextSnapshot,
  type ManagerPriorityReceipt,
} from "./manager-pair-protocol.ts"
import { ManagerSessionError } from "./manager-session-core.ts"
import type { TodoRequest } from "../todo/state.ts"

export interface NativeManagerState {
  readonly publish: (
    context: ManagerContextSnapshot,
  ) => Either.Either<void, ManagerSessionError>
  readonly context: () => Either.Either<
    ManagerContextSnapshot,
    ManagerSessionError
  >
  readonly enqueuePriorities: (
    text: string,
    revision: string,
  ) => Either.Either<string, ManagerSessionError>
  readonly enqueueTodo: (
    request: TodoRequest,
    revision: string,
  ) => Either.Either<string, ManagerSessionError>
  readonly processPriorities: (
    revision: () => string,
    apply: (text: string) => Either.Either<string, ManagerSessionError>,
    applyTodo?: (
      request: TodoRequest,
    ) => Either.Either<string, ManagerSessionError>,
  ) => Either.Either<readonly ManagerPriorityReceipt[], ManagerSessionError>
  readonly receipt: (
    id: string,
  ) => Either.Either<ManagerPriorityReceipt | undefined, ManagerSessionError>
}

export const prepareNativeManagerState = (
  directory: string,
  scope: ManagerPairScope,
): Either.Either<NativeManagerState, ManagerSessionError> =>
  Either.gen(function* () {
    if (!isAbsolute(directory))
      return yield* failure(
        "unsafe_state",
        "Manager state directory must be absolute.",
      )
    yield* io(() => mkdirSync(directory, { recursive: true, mode: 0o700 }))
    yield* privateDirectory(directory)

    if (!existsSync(join(directory, "scope.json"))) {
      yield* io(() =>
        writeFileSync(
          join(directory, "scope.json"),
          JSON.stringify({ version: 1, ...scope }),
          { flag: "wx", mode: 0o600 },
        ),
      )
      yield* io(() =>
        writeFileSync(
          join(directory, "capability.key"),
          randomBytes(32).toString("hex"),
          { flag: "wx", mode: 0o600 },
        ),
      )
    }

    for (const child of ["requests", "receipts"]) {
      yield* io(() =>
        mkdirSync(join(directory, child), { recursive: true, mode: 0o700 }),
      )
      yield* privateDirectory(join(directory, child))
    }
    return yield* openNativeManagerState(directory, scope)
  })

export const openNativeManagerState = (
  directory: string,
  scope: ManagerPairScope,
): Either.Either<NativeManagerState, ManagerSessionError> =>
  Either.gen(function* () {
    yield* privateDirectory(directory)
    const stored = yield* readJson(join(directory, "scope.json"))
    if (
      !record(stored) ||
      stored.version !== 1 ||
      stored.workerSessionId !== scope.workerSessionId ||
      stored.cwd !== scope.cwd
    ) {
      return yield* failure(
        "unauthorized",
        "Manager state belongs to another worker.",
      )
    }
    for (const child of ["requests", "receipts"])
      yield* privateDirectory(join(directory, child))

    const receipt = (
      id: string,
    ): Either.Either<ManagerPriorityReceipt | undefined, ManagerSessionError> =>
      Either.gen(function* () {
        if (!requestId(id))
          return yield* failure(
            "invalid_input",
            "Invalid manager request identity.",
          )
        const path = join(directory, "receipts", `${id}.json`)
        if (!existsSync(path)) return undefined
        const value = yield* readJson(path)
        if (
          !record(value) ||
          value.version !== 1 ||
          value.id !== id ||
          (value.status !== "completed" && value.status !== "failed") ||
          typeof value.message !== "string" ||
          value.message.length > 250_000
        ) {
          return yield* failure(
            "protocol",
            "Malformed manager priority receipt.",
          )
        }
        return { version: 1, id, status: value.status, message: value.message }
      })

    return {
      publish: context =>
        Either.flatMap(decodeManagerContext(context, scope), value =>
          atomicJson(directory, "context.json", value),
        ),
      context: () =>
        Either.flatMap(readJson(join(directory, "context.json")), value =>
          decodeManagerContext(value, scope),
        ),
      receipt,
      enqueuePriorities: (text, revision) =>
        Either.gen(function* () {
          const capability = yield* readPrivate(
            join(directory, "capability.key"),
            256,
          )
          const id = randomUUID()
          const command = yield* signManagerPriority(
            scope,
            id,
            revision,
            text,
            capability,
          )
          yield* atomicJson(join(directory, "requests"), `${id}.json`, command)
          return id
        }),
      enqueueTodo: (request, revision) =>
        Either.gen(function* () {
          const capability = yield* readPrivate(
            join(directory, "capability.key"),
            256,
          )
          const id = randomUUID()
          const command = yield* signManagerTodo(
            scope,
            id,
            revision,
            request,
            capability,
          )
          yield* atomicJson(join(directory, "requests"), `${id}.json`, command)
          return id
        }),
      processPriorities: (revision, apply, applyTodo) =>
        Either.gen(function* () {
          const names = yield* io(() =>
            readdirSync(join(directory, "requests")),
          )
          const requests = names
            .filter(name => /^[0-9a-f-]{36}\.json$/u.test(name))
            .sort()
            .slice(0, 32)
          if (requests.length === 0) return []
          const capability = yield* readPrivate(
            join(directory, "capability.key"),
            256,
          )
          const results: ManagerPriorityReceipt[] = []

          for (const name of requests) {
            const id = name.slice(0, -5)
            const previous = yield* receipt(id)
            const requestPath = join(directory, "requests", name)
            if (previous) {
              yield* io(() => unlinkSync(requestPath))
              continue
            }

            const value = yield* readJson(requestPath)
            const taskRequest =
              record(value) && value.version === 2 && value.operation === "todo"
            if (taskRequest && !applyTodo) continue
            const verified = taskRequest
              ? verifyManagerTodo(value, scope, revision(), capability)
              : verifyManagerPriority(value, scope, revision(), capability)
            let result: Either.Either<string, ManagerSessionError>
            if (Either.isLeft(verified)) result = Either.left(verified.left)
            else if (verified.right.id !== id)
              result = failure(
                "protocol",
                "Manager request identity does not match its queue entry.",
              )
            else if (verified.right.version === 2) {
              if (!applyTodo) continue
              result = applyTodo(verified.right.request)
            } else result = apply(verified.right.text)
            const outcome: ManagerPriorityReceipt = {
              version: 1,
              id,
              status: Either.isRight(result) ? "completed" : "failed",
              message: Either.isRight(result)
                ? result.right
                : result.left.message,
            }
            yield* atomicJson(join(directory, "receipts"), name, outcome)
            yield* io(() => unlinkSync(requestPath))
            results.push(outcome)
          }
          return results
        }),
    }
  })

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const requestId = (value: string): boolean => /^[0-9a-f-]{36}$/u.test(value)

const failure = (code: ManagerSessionError["code"], message: string) =>
  Either.left(new ManagerSessionError({ code, message }))

const io = <A>(run: () => A): Either.Either<A, ManagerSessionError> =>
  Either.try({
    try: run,
    catch: () =>
      new ManagerSessionError({
        code: "io",
        message: "Manager private state I/O failed.",
      }),
  })

const privateDirectory = (
  path: string,
): Either.Either<void, ManagerSessionError> =>
  Either.gen(function* () {
    const stat = yield* io(() => lstatSync(path))
    if (
      !isAbsolute(path) ||
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      (stat.mode & 0o077) !== 0 ||
      typeof process.getuid !== "function" ||
      stat.uid !== process.getuid()
    ) {
      return yield* failure(
        "unsafe_state",
        "Manager state requires an owner-only, non-symlink directory.",
      )
    }
  })

const readPrivate = (
  path: string,
  maximumBytes = 256_000,
): Either.Either<string, ManagerSessionError> =>
  Either.flatMap(
    io(() => {
      const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
      try {
        const stat = fstatSync(fd)
        if (
          !stat.isFile() ||
          stat.size > maximumBytes ||
          (stat.mode & 0o077) !== 0 ||
          typeof process.getuid !== "function" ||
          stat.uid !== process.getuid()
        ) {
          return failure(
            "unsafe_state",
            "Manager state file has unsafe ownership, permissions or size.",
          )
        }
        return Either.right(readFileSync(fd, "utf8"))
      } finally {
        closeSync(fd)
      }
    }),
    result => result,
  )

const readJson = (path: string): Either.Either<unknown, ManagerSessionError> =>
  Either.flatMap(readPrivate(path), text =>
    Either.try({
      try: (): unknown => JSON.parse(text),
      catch: () =>
        new ManagerSessionError({
          code: "protocol",
          message: "Manager state contains invalid JSON.",
        }),
    }),
  )

const atomicJson = (
  directory: string,
  name: string,
  value: unknown,
): Either.Either<void, ManagerSessionError> => {
  const temporary = join(directory, `pending-${randomUUID()}`)
  return io(() => {
    try {
      writeFileSync(temporary, JSON.stringify(value), {
        flag: "wx",
        mode: 0o600,
      })
      renameSync(temporary, join(directory, name))
    } finally {
      if (existsSync(temporary)) unlinkSync(temporary)
    }
  })
}
