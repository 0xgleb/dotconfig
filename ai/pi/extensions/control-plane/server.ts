import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http"
import type { AddressInfo } from "node:net"
import { Data, Effect } from "effect"
import { decodeJobSpec, JobRuntimeError } from "./job-runtime.ts"
import {
  JobStoreError,
  type SqliteJobStore,
} from "./sqlite-job-store.ts"

export const CONTROL_PLANE_PROTOCOL_VERSION = 1
export const CONTROL_PLANE_SCHEMA_VERSION = 1
const MAX_REQUEST_BODY_BYTES = 16 * 1_024
const LOOPBACK_HOSTS = ["127.0.0.1", "::1"] as const

export class ControlPlaneServerError extends Data.TaggedError(
  "ControlPlaneServerError",
)<{
  readonly code:
    | "invalid_bind"
    | "invalid_json"
    | "body_too_large"
    | "request_failed"
    | "listen_failed"
  readonly message: string
}> {}

export interface ControlPlaneServerOptions {
  readonly host: string
  readonly port: number
  readonly store: SqliteJobStore
}

export interface RunningControlPlaneServer {
  readonly host: string
  readonly port: number
  readonly origin: string
  readonly close: Effect.Effect<void, ControlPlaneServerError>
}

const serverError = (
  code: ControlPlaneServerError["code"],
  message: string,
): ControlPlaneServerError => new ControlPlaneServerError({ code, message })

const sendJson = (
  response: ServerResponse,
  status: number,
  value: unknown,
): void => {
  const body = JSON.stringify(value)
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body),
    "content-type": "application/json; charset=utf-8",
    "x-content-type-options": "nosniff",
  })
  response.end(body)
}

const sendError = (
  response: ServerResponse,
  status: number,
  code: string,
  message: string,
): void => sendJson(response, status, { error: { code, message } })

const readBody = (
  request: IncomingMessage,
): Effect.Effect<string, ControlPlaneServerError> =>
  Effect.async((resume) => {
    const chunks: Buffer[] = []
    let size = 0
    let settled = false
    const finish = (effect: Effect.Effect<string, ControlPlaneServerError>) => {
      if (settled) return
      settled = true
      resume(effect)
    }
    request.on("data", (chunk: Buffer | string) => {
      if (settled) return
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      size += buffer.length
      if (size > MAX_REQUEST_BODY_BYTES) {
        finish(
          Effect.fail(
            serverError(
              "body_too_large",
              `request body exceeds ${MAX_REQUEST_BODY_BYTES} bytes`,
            ),
          ),
        )
        return
      }
      chunks.push(buffer)
    })
    request.once("end", () =>
      finish(Effect.succeed(Buffer.concat(chunks).toString("utf8"))),
    )
    request.once("error", () =>
      finish(
        Effect.fail(serverError("request_failed", "request body read failed")),
      ),
    )
  })

const parseJson = (body: string): Effect.Effect<unknown, ControlPlaneServerError> =>
  Effect.try({
    try: () => JSON.parse(body) as unknown,
    catch: () => serverError("invalid_json", "request body is malformed JSON"),
  })

const internalFailure = (
  response: ServerResponse,
  error: unknown,
): Effect.Effect<void> => {
  if (error instanceof ControlPlaneServerError) {
    if (error.code === "body_too_large")
      sendError(response, 413, "body_too_large", "request body is too large")
    else if (error.code === "invalid_json")
      sendError(response, 400, "invalid_json", "request body is malformed JSON")
    else sendError(response, 400, "invalid_request", "request could not be read")
    return Effect.void
  }
  if (error instanceof JobRuntimeError && error.code === "invalid_input") {
    sendError(response, 400, "invalid_input", "job request is invalid")
    return Effect.void
  }
  if (error instanceof JobStoreError) {
    if (error.code === "idempotency_conflict")
      sendError(response, 409, "idempotency_conflict", "job key conflicts with existing input")
    else if (error.code === "capacity")
      sendError(response, 503, "capacity", "job store is at capacity")
    else sendError(response, 500, "internal_error", "control plane request failed")
    return Effect.void
  }
  sendError(response, 500, "internal_error", "control plane request failed")
  return Effect.void
}

const handleJobs = (
  request: IncomingMessage,
  response: ServerResponse,
  store: SqliteJobStore,
): Effect.Effect<void, unknown> => {
  if (request.method === "GET") {
    return Effect.map(store.list(), (jobs) => sendJson(response, 200, { jobs }))
  }
  if (request.method !== "POST") {
    sendError(response, 405, "method_not_allowed", "method is not allowed")
    return Effect.void
  }
  const contentType = request.headers["content-type"]?.split(";", 1)[0]?.trim()
  if (contentType !== "application/json") {
    sendError(response, 415, "unsupported_media_type", "application/json is required")
    return Effect.void
  }
  return Effect.gen(function* () {
    const body = yield* readBody(request)
    const input = yield* parseJson(body)
    const spec = yield* decodeJobSpec(input)
    const existing = yield* store.list()
    const job = yield* store.enqueue(spec)
    const alreadyExisted = existing.some(({ id }) => id === job.id)
    sendJson(response, alreadyExisted ? 200 : 201, { job })
  })
}

const handleRequest = (
  request: IncomingMessage,
  response: ServerResponse,
  store: SqliteJobStore,
): Effect.Effect<void> => {
  const route = Effect.try({
    try: () => new URL(request.url ?? "/", "http://127.0.0.1").pathname,
    catch: () => serverError("request_failed", "request URL is malformed"),
  })
  return Effect.catchAll(
    Effect.flatMap(route, (path) => {
      if (path === "/v1/health") {
        if (request.method !== "GET") {
          sendError(response, 405, "method_not_allowed", "method is not allowed")
          return Effect.void
        }
        sendJson(response, 200, {
          status: "ok",
          protocolVersion: CONTROL_PLANE_PROTOCOL_VERSION,
          schemaVersion: CONTROL_PLANE_SCHEMA_VERSION,
        })
        return Effect.void
      }
      if (path === "/v1/jobs") return handleJobs(request, response, store)
      sendError(response, 404, "not_found", "route was not found")
      return Effect.void
    }),
    (error) => internalFailure(response, error),
  )
}

export const startControlPlaneServer = (
  options: ControlPlaneServerOptions,
): Effect.Effect<RunningControlPlaneServer, ControlPlaneServerError> => {
  if (!LOOPBACK_HOSTS.includes(options.host as (typeof LOOPBACK_HOSTS)[number])) {
    return Effect.fail(
      serverError("invalid_bind", "control plane must bind to a loopback address"),
    )
  }
  if (!Number.isSafeInteger(options.port) || options.port < 0 || options.port > 65_535) {
    return Effect.fail(
      serverError("invalid_bind", "control plane port must be between 0 and 65535"),
    )
  }

  return Effect.async((resume) => {
    const server = createServer((request, response) => {
      void Effect.runPromise(handleRequest(request, response, options.store))
    })
    let settled = false
    server.once("error", () => {
      if (settled) return
      settled = true
      resume(
        Effect.fail(
          serverError("listen_failed", "control plane failed to listen"),
        ),
      )
    })
    server.listen(options.port, options.host, () => {
      if (settled) return
      settled = true
      const address = server.address() as AddressInfo | null
      if (!address) {
        server.close()
        resume(
          Effect.fail(
            serverError("listen_failed", "control plane has no bound address"),
          ),
        )
        return
      }
      const originHost = options.host === "::1" ? "[::1]" : options.host
      resume(
        Effect.succeed({
          host: options.host,
          port: address.port,
          origin: `http://${originHost}:${address.port}`,
          close: Effect.async<void, ControlPlaneServerError>((closeResume) => {
            server.close((closeError) =>
              closeResume(
                closeError
                  ? Effect.fail(
                      serverError(
                        "request_failed",
                        "control plane failed to close",
                      ),
                    )
                  : Effect.void,
              ),
            )
          }),
        }),
      )
    })
  })
}
