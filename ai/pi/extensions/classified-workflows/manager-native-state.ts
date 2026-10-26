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
  createManagerTaskAuthority,
  type ManagerTaskAuthority,
} from "./manager-task-protocol.ts"
import {
  decodeManagerContext,
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
  readonly taskAuthority?: ManagerTaskAuthority
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
          (value.status !== "completed" &&
            value.status !== "failed" &&
            value.status !== "started" &&
            value.status !== "unconfirmed") ||
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
      taskAuthority: createManagerTaskAuthority(
        Object.freeze({
          workerSessionId: stored.workerSessionId,
          cwd: stored.cwd,
        }),
        () => readPrivate(join(directory, "capability.key"), 256),
      ),
      enqueuePriorities: () =>
        failure(
          "unavailable",
          `Queued manager calls are retired for ${scope.cwd} (session ${scope.workerSessionId}); use direct task control.`,
        ),
      enqueueTodo: () =>
        failure(
          "unavailable",
          `Queued manager calls are retired for ${scope.cwd} (session ${scope.workerSessionId}); use direct task control.`,
        ),
      // Callable compatibility only: historical commands remain inert.
      processPriorities: () => Either.right([]),
    }
  })

const reserveReceipt = (
  directory: string,
  id: string,
): Either.Either<"claimed" | "existing", ManagerSessionError> => {
  const written = Either.try({
    try: () =>
      writeFileSync(
        join(directory, `${id}.json`),
        JSON.stringify({
          version: 1,
          id,
          status: "started",
          message: "Worker request started; result is not confirmed.",
        } satisfies ManagerPriorityReceipt),
        { flag: "wx", mode: 0o600 },
      ),
    catch: (error): unknown => error,
  })
  if (Either.isRight(written)) return Either.right("claimed")
  const error = written.left
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "EEXIST"
  )
    return Either.right("existing")
  return failure("io", "Could not reserve the worker request before execution.")
}

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
