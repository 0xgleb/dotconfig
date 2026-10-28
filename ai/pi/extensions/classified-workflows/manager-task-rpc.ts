import { Effect, Either } from "effect"
import { randomUUID } from "node:crypto"
import { chmodSync, lstatSync } from "node:fs"
import { createConnection, createServer, type Socket } from "node:net"
import { isAbsolute, join } from "node:path"
import { performance } from "node:perf_hooks"
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
const TASK_WINDOW_MS = 2000
const MAX_LIVE_REQUEST_IDS = 4096
const rpcError = (code: ManagerSessionError["code"], message: string) =>
  new ManagerSessionError({ code, message })
const monotonicNow = () => Math.floor(performance.now())
const endpoint = (directory: string) =>
  Either.gen(function* () {
    if (
      typeof directory !== "string" ||
      !isAbsolute(directory) ||
      /[\u0000-\u001f\u007f]/u.test(directory) ||
      typeof process.getuid !== "function"
    )
      return yield* Either.left(
        rpcError("unsafe_state", "Invalid private task endpoint directory."),
      )
    const path = join(directory, "task.sock")
    if (Buffer.byteLength(path) > 100)
      return yield* Either.left(
        rpcError(
          "unsafe_state",
          "Private task socket path exceeds the supported Unix limit.",
        ),
      )
    const inspected = yield* Either.try({
      try: () => ({ stat: lstatSync(directory), uid: process.getuid?.() }),
      catch: () =>
        rpcError(
          "unavailable",
          "Private worker endpoint directory is unavailable.",
        ),
    })
    if (
      !inspected.stat.isDirectory() ||
      inspected.stat.uid !== inspected.uid ||
      (inspected.stat.mode & 0o077) !== 0
    )
      return yield* Either.left(
        rpcError(
          "unsafe_state",
          "Worker endpoint directory must be private, owned and non-symlink.",
        ),
      )
    return path
  })
const encodeFrame = (value: unknown, limit: number) =>
  Either.gen(function* () {
    const payload = yield* Either.try({
      try: () => Buffer.from(JSON.stringify(value)),
      catch: () => rpcError("protocol", "Invalid task protocol frame."),
    })
    if (payload.length === 0 || payload.length > limit)
      return yield* Either.left(
        rpcError("protocol", "Task protocol frame exceeds its limit."),
      )
    const prefix = Buffer.alloc(4)
    prefix.writeUInt32BE(payload.length)
    return Buffer.concat([prefix, payload])
  })
const readFrame = (
  socket: Socket,
  limit: number,
  fail: (error: ManagerSessionError) => void,
  receive: (value: unknown) => void,
) => {
  let buffer: Buffer = Buffer.alloc(0)
  const consume = (chunk: Buffer) => {
    if (buffer.length + chunk.length > limit + 4)
      return stop(rpcError("protocol", "Oversized task protocol frame."))
    buffer = Buffer.concat([buffer, chunk])
    if (buffer.length < 4) return
    const length = buffer.readUInt32BE(0)
    if (length === 0 || length > limit || buffer.length > length + 4)
      return stop(rpcError("protocol", "Invalid task protocol frame length."))
    if (buffer.length < length + 4) return
    socket.off("data", consume)
    socket.pause()
    const parsed = Either.try({
      try: (): unknown => JSON.parse(buffer.subarray(4).toString("utf8")),
      catch: () => rpcError("protocol", "Malformed task protocol JSON."),
    })
    if (Either.isLeft(parsed)) fail(parsed.left)
    else receive(parsed.right)
  }
  const stop = (error: ManagerSessionError) => {
    socket.off("data", consume)
    socket.pause()
    fail(error)
  }
  socket.on("data", consume)
  socket.resume()
}

export const startManagerTaskServer = (
  input: ManagerTaskServerInput,
): Effect.Effect<ManagerTaskServer, ManagerSessionError> =>
  Effect.flatMap(endpoint(input.directory), path =>
    Effect.async<ManagerTaskServer, ManagerSessionError>(resume => {
      let phase: "starting" | "active" | "closed" = "starting"
      const peers = new Set<Socket>()
      const seen = new Map<string, number>()
      const now = input.now ?? monotonicNow
      const revision = () =>
        Either.flatMap(
          Either.try({
            try: input.revision,
            catch: () =>
              rpcError("unavailable", "Worker scope could not be read."),
          }),
          value => value,
        )
      const server = createServer(socket => {
        if (phase !== "active") {
          socket.destroy()
          return
        }
        peers.add(socket)
        socket.once("close", () => peers.delete(socket))
        socket.on("error", () => socket.destroy())
        socket.setTimeout(TASK_WINDOW_MS, () => socket.destroy())
        const initial = revision()
        if (Either.isLeft(initial)) {
          socket.destroy()
          return
        }
        const hello = input.authority.hello(
          randomUUID(),
          initial.right,
          now() + TASK_WINDOW_MS,
        )
        if (Either.isLeft(hello)) {
          socket.destroy()
          return
        }
        const greeting = encodeFrame(hello.right, MAX_MANAGER_TASK_FRAME_BYTES)
        if (Either.isLeft(greeting)) {
          socket.destroy()
          return
        }
        readFrame(
          socket,
          MAX_MANAGER_TASK_REQUEST_BYTES,
          () => socket.destroy(),
          value => {
            if (phase !== "active" || socket.destroyed) {
              socket.destroy()
              return
            }
            const current = revision()
            const at = now()
            const command = Either.flatMap(current, revision =>
              input.authority.readCommand(value, hello.right, revision, at),
            )
            const id =
              typeof value === "object" &&
              value !== null &&
              "id" in value &&
              typeof value.id === "string"
                ? value.id
                : undefined
            if (!id) {
              socket.destroy()
              return
            }
            let result: ManagerTaskResult
            if (Either.isLeft(command))
              result = { outcome: "failed", message: command.left.message }
            else {
              const selected = command.right
              for (const [requestId, expiresAt] of seen)
                if (expiresAt <= at) seen.delete(requestId)
              if (seen.has(selected.id))
                result = {
                  outcome: "unconfirmed",
                  message:
                    "Duplicate task call; inspect worker state before another call.",
                }
              else if (seen.size >= MAX_LIVE_REQUEST_IDS)
                result = {
                  outcome: "failed",
                  message:
                    "Task endpoint replay protection is at capacity; no operation was dispatched.",
                }
              else {
                seen.set(selected.id, hello.right.expiresAt)
                const invoked = Either.gen(function* () {
                  const beforeDispatch = yield* Either.try({
                    try: now,
                    catch: () =>
                      rpcError(
                        "io",
                        "Worker deadline clock could not be read.",
                      ),
                  })
                  if (
                    !Number.isSafeInteger(beforeDispatch) ||
                    beforeDispatch < 0
                  )
                    return yield* Either.left(
                      rpcError(
                        "protocol",
                        "Worker monotonic clock is invalid.",
                      ),
                    )
                  if (
                    beforeDispatch >= selected.expiresAt ||
                    beforeDispatch >= hello.right.expiresAt
                  )
                    return yield* Either.left(
                      rpcError(
                        "stale_revision",
                        "Task deadline expired before dispatch.",
                      ),
                    )
                  return yield* Either.flatMap(
                    Either.try({
                      try: () => input.invoke(selected.operation),
                      catch: () =>
                        rpcError(
                          "unconfirmed",
                          "Worker persistence result is unconfirmed; inspect before retry.",
                        ),
                    }),
                    operation => operation,
                  )
                })
                result = Either.isRight(invoked)
                  ? { outcome: "completed", message: invoked.right }
                  : {
                      outcome:
                        invoked.left.code === "unconfirmed"
                          ? "unconfirmed"
                          : "failed",
                      message: invoked.left.message,
                    }
              }
            }
            const response = input.authority.response(
              { id, nonce: hello.right.nonce },
              result,
            )
            const encoded = Either.flatMap(response, packet =>
              encodeFrame(packet, MAX_MANAGER_TASK_FRAME_BYTES),
            )
            if (Either.isLeft(encoded)) socket.destroy()
            else socket.end(encoded.right)
          },
        )
        socket.write(greeting.right)
      })
      server.maxConnections = 16
      const close: ManagerTaskServer["close"] = Effect.async(done => {
        if (phase === "closed") {
          done(Effect.void)
          return
        }
        phase = "closed"
        for (const socket of peers) socket.destroy()
        seen.clear()
        const closing = Either.try({
          try: () =>
            server.close(error =>
              done(
                error
                  ? Effect.fail(
                      rpcError(
                        "io",
                        "Worker task endpoint could not close cleanly.",
                      ),
                    )
                  : Effect.void,
              ),
            ),
          catch: () => rpcError("io", "Worker task endpoint close failed."),
        })
        if (Either.isLeft(closing)) done(Effect.fail(closing.left))
      })
      server.on("error", () => {
        if (phase === "starting") {
          phase = "closed"
          resume(
            Effect.fail(
              rpcError(
                "unavailable",
                "A live or stale task endpoint already exists, or the endpoint cannot be bound.",
              ),
            ),
          )
        } else {
          for (const socket of peers) socket.destroy()
        }
      })
      const listening = Either.try({
        try: () =>
          server.listen(path, () => {
            const secured = Either.try({
              try: () => chmodSync(path, 0o600),
              catch: () =>
                rpcError(
                  "unsafe_state",
                  "Could not secure the worker task endpoint.",
                ),
            })
            if (phase === "closed" || Either.isLeft(secured)) {
              server.close()
              if (Either.isLeft(secured)) resume(Effect.fail(secured.left))
              return
            }
            phase = "active"
            resume(Effect.succeed({ close }))
          }),
        catch: () =>
          rpcError("unavailable", "Worker task endpoint could not start."),
      })
      if (Either.isLeft(listening)) {
        phase = "closed"
        resume(Effect.fail(listening.left))
      }
      return Effect.sync(() => {
        phase = "closed"
        for (const socket of peers) socket.destroy()
        if (server.listening) server.close()
      })
    }),
  )

export const callManagerTask = (
  input: ManagerTaskCallInput,
): Effect.Effect<ManagerTaskResult, ManagerSessionError> =>
  Effect.gen(function* () {
    if (
      !Number.isSafeInteger(input.timeoutMs) ||
      input.timeoutMs <= 0 ||
      input.timeoutMs > 30_000
    )
      return yield* Effect.fail(
        rpcError(
          "invalid_input",
          "Direct task timeout must be a positive bounded number of milliseconds.",
        ),
      )
    if (input.signal?.aborted)
      return yield* Effect.fail(
        rpcError(
          "unavailable",
          "Direct task call was cancelled before dispatch.",
        ),
      )
    const path = yield* endpoint(input.directory)
    yield* Either.try({
      try: () => {
        const stat = lstatSync(path)
        return (
          stat.isSocket() &&
          stat.uid === process.getuid?.() &&
          (stat.mode & 0o077) === 0
        )
      },
      catch: () =>
        rpcError(
          "unavailable",
          "Selected worker has no live direct task endpoint.",
        ),
    }).pipe(
      Either.flatMap(safe =>
        safe
          ? Either.right(undefined)
          : Either.left(
              rpcError(
                "unsafe_state",
                "Selected task endpoint is not a private owned socket.",
              ),
            ),
      ),
    )
    return yield* Effect.async<ManagerTaskResult, ManagerSessionError>(
      resume => {
        let settled = false
        let sent = false
        const startedAt = monotonicNow()
        const socket = createConnection(path)
        const uncertainty = () =>
          rpcError(
            sent ? "unconfirmed" : "unavailable",
            sent
              ? "Direct worker result is unconfirmed; operation may have committed. Inspect the selected worker before retry."
              : "Selected worker endpoint is unavailable; no command was dispatched.",
          )
        const finish = (
          result: Either.Either<ManagerTaskResult, ManagerSessionError>,
        ) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          input.signal?.removeEventListener("abort", cancel)
          socket.destroy()
          resume(result)
        }
        const cancel = () => finish(Either.left(uncertainty()))
        const timer = setTimeout(cancel, input.timeoutMs)
        input.signal?.addEventListener("abort", cancel, { once: true })
        socket.on("error", cancel)
        socket.on("end", cancel)
        socket.on("close", cancel)
        if (input.signal?.aborted) {
          cancel()
          return
        }
        readFrame(
          socket,
          MAX_MANAGER_TASK_FRAME_BYTES,
          error => finish(Either.left(sent ? uncertainty() : error)),
          value => {
            const hello = input.authority.readHello(value)
            if (Either.isLeft(hello)) {
              finish(Either.left(hello.left))
              return
            }
            if (
              hello.right.workerSessionId !== input.scope.workerSessionId ||
              hello.right.cwd !== input.scope.cwd
            ) {
              finish(
                Either.left(
                  rpcError(
                    "unauthorized",
                    "Direct task endpoint targets another worker.",
                  ),
                ),
              )
              return
            }
            const remaining = input.timeoutMs - (monotonicNow() - startedAt)
            if (remaining <= 0 || input.signal?.aborted) {
              cancel()
              return
            }
            // Worker-issued monotonic ticks avoid wall-clock changes. Anchoring the
            // remaining client budget at worker acceptance is conservative, not a lease extension.
            const expiresAt =
              hello.right.expiresAt -
              TASK_WINDOW_MS +
              Math.min(TASK_WINDOW_MS, remaining)
            const command = input.authority.command(
              hello.right,
              randomUUID(),
              input.operation,
              expiresAt,
            )
            if (Either.isLeft(command)) {
              finish(Either.left(command.left))
              return
            }
            const encoded = encodeFrame(
              command.right,
              MAX_MANAGER_TASK_REQUEST_BYTES,
            )
            if (Either.isLeft(encoded)) {
              finish(Either.left(encoded.left))
              return
            }
            readFrame(
              socket,
              MAX_MANAGER_TASK_FRAME_BYTES,
              () => finish(Either.left(uncertainty())),
              packet => {
                const verified = input.authority.readResponse(
                  packet,
                  command.right,
                )
                finish(
                  Either.isRight(verified)
                    ? Either.right(verified.right.result)
                    : Either.left(uncertainty()),
                )
              },
            )
            if (settled) return
            if (
              input.signal?.aborted ||
              monotonicNow() - startedAt >= input.timeoutMs
            ) {
              cancel()
              return
            }
            sent = true
            const writing = Either.try({
              try: () => socket.write(encoded.right),
              catch: uncertainty,
            })
            if (Either.isLeft(writing)) finish(Either.left(writing.left))
          },
        )
        return Effect.sync(() => {
          clearTimeout(timer)
          input.signal?.removeEventListener("abort", cancel)
          socket.destroy()
        })
      },
    )
  })
