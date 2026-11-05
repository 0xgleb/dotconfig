import { randomUUID } from "node:crypto"
import {
  constants,
  openSync,
  closeSync,
  fstatSync,
  lstatSync,
  readFileSync,
  writeFileSync,
  renameSync,
  linkSync,
  unlinkSync,
  mkdirSync,
  existsSync,
  readdirSync,
} from "node:fs"
import { isAbsolute, join } from "node:path"
import { Either } from "effect"
import {
  decodeManagerContext,
  type ManagerPairScope,
  type ManagerContextSnapshot,
  type ManagerPriorityReceipt,
} from "./manager-pair-protocol.ts"
import {
  ManagerSessionError,
  managerPairDirectory,
} from "./manager-session-core.ts"
import type { TodoRequest } from "../todo/state.ts"
import {
  OWNER_PROGRESS_CHECK_IN_MS,
  SUPERVISED_OWNER_ALLOWANCE_MS,
  type OwnerProgressCheckIn,
} from "./owner-allowance.ts"

export interface NativeManagerCheckIn {
  readonly version: 1
  readonly id: string
  readonly queuedAt: number
  readonly checkIn: OwnerProgressCheckIn
  readonly context: ManagerContextSnapshot
}

export interface NativeManagerCheckInReceipt {
  readonly id: string
  readonly status: "queued" | "review-requested" | "reviewed" | "failed"
  readonly message: string
  readonly updatedAt: number
}

export interface NativeManagerCheckIns {
  readonly enqueue: (
    checkIn: OwnerProgressCheckIn,
    context: ManagerContextSnapshot,
    now: number,
  ) => Either.Either<string, ManagerSessionError>
  readonly take: (
    now: number,
  ) => Either.Either<NativeManagerCheckIn | undefined, ManagerSessionError>
  readonly finish: (
    id: string,
    outcome: {
      readonly status: "reviewed" | "failed"
      readonly message: string
    },
    now: number,
  ) => Either.Either<void, ManagerSessionError>
  readonly receipt: (
    id: string,
    now: number,
  ) => Either.Either<
    NativeManagerCheckInReceipt | undefined,
    ManagerSessionError
  >
}

export interface NativeManagerState {
  readonly checkIns?: NativeManagerCheckIns
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

export interface NativeManagerCheckInReview {
  readonly request: NativeManagerCheckIn
  readonly finish: (
    outcome: {
      readonly status: "reviewed" | "failed"
      readonly message: string
    },
    now: number,
  ) => Either.Either<void, ManagerSessionError>
}

export const takeNativeManagerCheckIn = (
  agentDir: string,
  now: number,
): Either.Either<NativeManagerCheckInReview | undefined, ManagerSessionError> =>
  Either.gen(function* () {
    if (!isAbsolute(agentDir))
      return yield* failure(
        "invalid_input",
        "Manager check-in lookup requires an absolute agent directory.",
      )
    const root = join(agentDir, "manager")
    if (!existsSync(root)) return undefined
    yield* privateDirectory(root)
    const names = yield* io(() => readdirSync(root))
    for (const name of names
      .filter(
        name =>
          /^[0-9a-f]{24}$/u.test(name) &&
          existsSync(join(root, name, "check-ins")),
      )
      .sort()) {
      const directory = join(root, name)
      yield* privateDirectory(directory)
      const stored = yield* readJson(join(directory, "scope.json"))
      if (
        !record(stored) ||
        stored.version !== 1 ||
        typeof stored.workerSessionId !== "string" ||
        typeof stored.cwd !== "string"
      )
        return yield* failure(
          "protocol",
          "Malformed worker scope in check-in channel.",
        )
      const scope = { workerSessionId: stored.workerSessionId, cwd: stored.cwd }
      const expected = yield* managerPairDirectory({
        agentDir,
        workerSessionId: scope.workerSessionId,
        workerCwd: scope.cwd,
      })
      if (expected !== directory)
        return yield* failure(
          "unauthorized",
          "Check-in channel belongs to another worker scope.",
        )
      const state = yield* openNativeManagerState(directory, scope)
      const channel = state.checkIns
      if (!channel)
        return yield* failure(
          "unavailable",
          "Worker check-in channel is unavailable.",
        )
      const request = yield* channel.take(now)
      if (request)
        return {
          request,
          finish: (
            outcome: {
              readonly status: "reviewed" | "failed"
              readonly message: string
            },
            at: number,
          ) => channel.finish(request.id, outcome, at),
        }
    }
    return undefined
  })

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
      typeof stored.workerSessionId !== "string" ||
      typeof stored.cwd !== "string" ||
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
      checkIns: nativeCheckIns(
        directory,
        Object.freeze({
          workerSessionId: stored.workerSessionId,
          cwd: stored.cwd,
        }),
      ),
      publish: context =>
        Either.flatMap(decodeManagerContext(context, scope), value =>
          atomicJson(directory, "context.json", value),
        ),
      context: () =>
        Either.flatMap(readJson(join(directory, "context.json")), value =>
          decodeManagerContext(value, scope),
        ),
      receipt,
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

const checkInTime = (value: unknown): value is number =>
  typeof value === "number" &&
  Number.isSafeInteger(value) &&
  value >= 0 &&
  value <= 8_640_000_000_000_000
const checkInId = (value: string) =>
  /^[0-9]{1,16}-[1-9][0-9]{0,5}$/u.test(value)

const decodeCheckIn = (
  value: unknown,
  scope: ManagerPairScope,
): Either.Either<NativeManagerCheckIn, ManagerSessionError> =>
  Either.gen(function* () {
    if (
      !record(value) ||
      value.version !== 1 ||
      typeof value.id !== "string" ||
      !checkInId(value.id) ||
      !checkInTime(value.queuedAt) ||
      !record(value.checkIn) ||
      !record(value.checkIn.window)
    )
      return yield* failure("protocol", "Malformed manager check-in.")
    const checkIn = value.checkIn
    const window = checkIn.window
    if (
      !record(window) ||
      window.version !== 1 ||
      window.status !== "active" ||
      !checkInTime(window.lastOwnerAt) ||
      !checkInTime(window.deadlineAt) ||
      window.deadlineAt <= window.lastOwnerAt ||
      window.deadlineAt - window.lastOwnerAt > SUPERVISED_OWNER_ALLOWANCE_MS ||
      typeof checkIn.sequence !== "number" ||
      !Number.isSafeInteger(checkIn.sequence) ||
      checkIn.sequence < 1 ||
      !checkInTime(checkIn.scheduledAt) ||
      checkIn.scheduledAt !==
        window.lastOwnerAt + checkIn.sequence * OWNER_PROGRESS_CHECK_IN_MS ||
      checkIn.scheduledAt >= window.deadlineAt ||
      value.queuedAt < checkIn.scheduledAt ||
      value.queuedAt >= window.deadlineAt ||
      value.id !== `${window.lastOwnerAt}-${checkIn.sequence}`
    )
      return yield* failure("protocol", "Malformed manager check-in window.")
    const context = yield* decodeManagerContext(value.context, scope)
    if (
      context.observedAt < checkIn.scheduledAt ||
      context.observedAt > value.queuedAt
    )
      return yield* failure(
        "stale_revision",
        "Check-in requires a current worker snapshot.",
      )
    return {
      version: 1,
      id: value.id,
      queuedAt: value.queuedAt,
      context,
      checkIn: {
        window: {
          version: 1,
          status: "active",
          lastOwnerAt: window.lastOwnerAt,
          deadlineAt: window.deadlineAt,
        },
        sequence: checkIn.sequence,
        scheduledAt: checkIn.scheduledAt,
      },
    }
  })

const nativeCheckIns = (
  directory: string,
  scope: ManagerPairScope,
): NativeManagerCheckIns => {
  const requests = join(directory, "check-ins")
  const receipts = join(directory, "check-in-receipts")
  const read = (id: string) =>
    Either.gen(function* () {
      if (!checkInId(id))
        return yield* failure("invalid_input", "Invalid check-in identity.")
      yield* privateDirectory(directory)
      if (!existsSync(requests)) return undefined
      yield* privateDirectory(requests)
      const path = join(requests, `${id}.json`)
      if (!existsSync(path)) return undefined
      const request = yield* Either.flatMap(readJson(path), value =>
        decodeCheckIn(value, scope),
      )
      if (request.id !== id)
        return yield* failure(
          "protocol",
          "Check-in identity does not match its file.",
        )
      return request
    })
  const receipt: NativeManagerCheckIns["receipt"] = (id, now) =>
    Either.gen(function* () {
      if (!checkInTime(now))
        return yield* failure("invalid_input", "Invalid check-in clock.")
      const request = yield* read(id)
      if (!request) return undefined
      yield* privateDirectory(receipts)
      const path = join(receipts, `${id}.json`)
      let result: NativeManagerCheckInReceipt = {
        id,
        status: "queued",
        message: "Manager review queued.",
        updatedAt: request.queuedAt,
      }
      if (existsSync(path)) {
        const stored = yield* readJson(path)
        if (
          !record(stored) ||
          stored.id !== id ||
          (stored.status !== "review-requested" &&
            stored.status !== "reviewed" &&
            stored.status !== "failed") ||
          typeof stored.message !== "string" ||
          stored.message.length > 12000 ||
          !checkInTime(stored.updatedAt)
        )
          return yield* failure("protocol", "Malformed check-in receipt.")
        result = {
          id,
          status: stored.status,
          message: stored.message,
          updatedAt: stored.updatedAt,
        }
      }
      if (
        now >= request.checkIn.window.deadlineAt &&
        result.status !== "reviewed" &&
        result.status !== "failed"
      ) {
        result = {
          id,
          status: "failed",
          message: "Worker allowance expired before manager review completed.",
          updatedAt: now,
        }
        yield* atomicJson(receipts, `${id}.json`, result)
      }
      return result
    })
  return {
    enqueue: (checkIn, context, now) =>
      Either.gen(function* () {
        if (!checkInTime(now) || now >= checkIn.window.deadlineAt)
          return yield* failure(
            "invalid_input",
            "Check-in allowance is expired or its clock is invalid.",
          )
        const id = `${checkIn.window.lastOwnerAt}-${checkIn.sequence}`
        const request = yield* decodeCheckIn(
          { version: 1, id, queuedAt: now, checkIn, context },
          scope,
        )
        const payload = yield* encodePrivateJson(request)
        yield* privateDirectory(directory)
        for (const path of [requests, receipts]) {
          yield* io(() => mkdirSync(path, { recursive: true, mode: 0o700 }))
          yield* privateDirectory(path)
        }
        const created = yield* publishExclusiveJson(
          requests,
          `${id}.json`,
          payload,
        )
        if (created === "existing") {
          const existing = yield* read(id)
          if (
            !existing ||
            existing.checkIn.window.deadlineAt !== checkIn.window.deadlineAt
          )
            return yield* failure(
              "stale_revision",
              "Check-in already exists under another deadline.",
            )
        }
        return id
      }),
    take: now =>
      Either.gen(function* () {
        if (!checkInTime(now))
          return yield* failure("invalid_input", "Invalid check-in clock.")
        yield* privateDirectory(directory)
        if (!existsSync(requests)) return undefined
        yield* privateDirectory(requests)
        yield* privateDirectory(receipts)
        const names = yield* io(() => readdirSync(requests))
        for (const name of names
          .filter(
            name =>
              name.endsWith(".json") &&
              checkInId(name.slice(0, -5)) &&
              !existsSync(join(receipts, name)),
          )
          .sort()
          .slice(0, 32)) {
          const id = name.slice(0, -5)
          const current = yield* receipt(id, now)
          if (!current || current.status !== "queued") continue
          const reserved = yield* reserveReceipt(receipts, id, {
            id,
            status: "review-requested",
            message: "Manager review requested; completion is not confirmed.",
            updatedAt: now,
          })
          if (reserved === "existing") continue
          return yield* read(id)
        }
        return undefined
      }),
    finish: (id, outcome, now) =>
      Either.gen(function* () {
        if (
          !checkInTime(now) ||
          (outcome.status !== "reviewed" && outcome.status !== "failed") ||
          !outcome.message.trim() ||
          outcome.message.length > 12000
        )
          return yield* failure(
            "invalid_input",
            "Invalid manager review result.",
          )
        const current = yield* receipt(id, now)
        if (!current || current.status !== "review-requested")
          return yield* failure(
            "unconfirmed",
            "No pending manager review can accept this result.",
          )
        yield* atomicJson(receipts, `${id}.json`, {
          id,
          status: outcome.status,
          message: outcome.message,
          updatedAt: now,
        } satisfies NativeManagerCheckInReceipt)
      }),
    receipt,
  }
}

const reserveReceipt = (
  directory: string,
  id: string,
  initial?: NativeManagerCheckInReceipt,
): Either.Either<"claimed" | "existing", ManagerSessionError> =>
  Either.gen(function* () {
    const payload = yield* encodePrivateJson(
      initial ??
        ({
          version: 1,
          id,
          status: "started",
          message: "Worker request started; result is not confirmed.",
        } satisfies ManagerPriorityReceipt),
    )
    const outcome = yield* publishExclusiveJson(
      directory,
      `${id}.json`,
      payload,
    )
    return outcome === "created" ? "claimed" : "existing"
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

const PRIVATE_STATE_MAX_BYTES = 256_000

const readPrivate = (
  path: string,
  maximumBytes = PRIVATE_STATE_MAX_BYTES,
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

const encodePrivateJson = (
  value: unknown,
): Either.Either<string, ManagerSessionError> =>
  Either.gen(function* () {
    const payload = yield* io(() => JSON.stringify(value))
    if (typeof payload !== "string")
      return yield* failure("io", "Manager state could not be serialized.")
    if (Buffer.byteLength(payload) > PRIVATE_STATE_MAX_BYTES)
      return yield* failure(
        "unsafe_state",
        "Manager state payload exceeds the private-file byte limit.",
      )
    return payload
  })

const publishExclusiveJson = (
  directory: string,
  name: string,
  payload: string,
): Either.Either<"created" | "existing", ManagerSessionError> =>
  Either.gen(function* () {
    const temporary = yield* io(() =>
      join(directory, `pending-${randomUUID()}`),
    )
    const fd = yield* io(() =>
      openSync(
        temporary,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
        0o600,
      ),
    )
    const written = io(() => writeFileSync(fd, payload))
    const closed = io(() => closeSync(fd))

    const published = Either.flatMap(
      Either.flatMap(written, () => closed),
      () => {
        const linked = Either.try({
          try: () => linkSync(temporary, join(directory, name)),
          catch: (error): unknown => error,
        })
        if (Either.isRight(linked)) return Either.right("created" as const)
        if (record(linked.left) && linked.left.code === "EEXIST")
          return Either.right("existing" as const)
        return failure("io", "Manager state could not be published.")
      },
    )

    const removed = io(() => unlinkSync(temporary))
    if (Either.isLeft(published)) return yield* published
    yield* removed
    return published.right
  })

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
