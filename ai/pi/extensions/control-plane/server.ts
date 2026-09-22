import { randomUUID } from "node:crypto"
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http"
import { readFile } from "node:fs/promises"
import type { AddressInfo } from "node:net"
import { isAbsolute, join } from "node:path"
import { Data, Effect } from "effect"
import {
  decodeHarnessReviewHandoff,
  harnessHandoffMatchesAttempt,
} from "./harness-protocol.ts"
import { decodeJobSpec, JobRuntimeError } from "./job-runtime.ts"
import {
  isIdempotencyKeyFilter,
  isRegisteredKindFilter,
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
    | "invalid_dashboard"
  readonly message: string
}> {}

export interface ControlPlaneServerOptions {
  readonly host: string
  readonly port: number
  readonly store: SqliteJobStore
  readonly dashboardDirectory?: string
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

const sendAsset = (
  response: ServerResponse,
  contentType: string,
  body: Buffer,
): void => {
  response.writeHead(200, {
    "cache-control": "no-store",
    "content-length": body.length,
    "content-security-policy": "default-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    "content-type": contentType,
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
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

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

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
  if (error instanceof JobRuntimeError) {
    if (error.code === "invalid_input")
      sendError(response, 400, "invalid_input", "job request is invalid")
    else if (error.code === "stale_lease")
      sendError(response, 409, "stale_lease", "job lease is stale")
    else
      sendError(response, 409, "invalid_transition", "job state has changed")
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
    const result = yield* store.enqueue(spec)
    sendJson(response, result.created ? 201 : 200, { job: result.job })
  })
}

const hasJsonContentType = (request: IncomingMessage): boolean =>
  request.headers["content-type"]?.split(";", 1)[0]?.trim() ===
  "application/json"

const exactKeys = (
  value: Readonly<Record<string, unknown>>,
  expected: readonly string[],
): boolean =>
  Object.keys(value).length === expected.length &&
  Object.keys(value).every((key) => expected.includes(key))

const handleClaim = (
  request: IncomingMessage,
  response: ServerResponse,
  store: SqliteJobStore,
): Effect.Effect<void, unknown> => {
  if (request.method !== "POST") {
    sendError(response, 405, "method_not_allowed", "method is not allowed")
    return Effect.void
  }
  if (!hasJsonContentType(request)) {
    sendError(response, 415, "unsupported_media_type", "application/json is required")
    return Effect.void
  }
  return Effect.gen(function* () {
    const input = yield* Effect.flatMap(readBody(request), parseJson)
    const CLAIM_KEYS = ["workerId", "ttlMs", "kinds", "idempotencyKeys"]
    if (
      !isRecord(input) ||
      !Object.keys(input).every((key) => CLAIM_KEYS.includes(key)) ||
      typeof input.workerId !== "string" ||
      typeof input.ttlMs !== "number" ||
      ("kinds" in input &&
        (!Array.isArray(input.kinds) ||
          !isRegisteredKindFilter(input.kinds))) ||
      ("idempotencyKeys" in input &&
        (!Array.isArray(input.idempotencyKeys) ||
          !isIdempotencyKeyFilter(input.idempotencyKeys)))
    ) {
      return yield* Effect.fail(
        serverError("request_failed", "worker claim payload is invalid"),
      )
    }
    const job = yield* store.claimDue(
      input.workerId,
      randomUUID(),
      Date.now(),
      input.ttlMs,
      "kinds" in input && Array.isArray(input.kinds) && isRegisteredKindFilter(input.kinds)
        ? input.kinds
        : undefined,
      "idempotencyKeys" in input &&
        Array.isArray(input.idempotencyKeys) &&
        isIdempotencyKeyFilter(input.idempotencyKeys)
        ? input.idempotencyKeys
        : undefined,
    )
    if (job === undefined) response.writeHead(204).end()
    else sendJson(response, 200, { job })
  })
}

const handleComplete = (
  id: string,
  request: IncomingMessage,
  response: ServerResponse,
  store: SqliteJobStore,
): Effect.Effect<void, unknown> => {
  if (request.method !== "POST") {
    sendError(response, 405, "method_not_allowed", "method is not allowed")
    return Effect.void
  }
  if (!hasJsonContentType(request)) {
    sendError(response, 415, "unsupported_media_type", "application/json is required")
    return Effect.void
  }
  return Effect.gen(function* () {
    const input = yield* Effect.flatMap(readBody(request), parseJson)
    const current = yield* store.get(id)
    if (current.spec.kind === "harness.review") {
      if (
        !isRecord(input) ||
        !exactKeys(input, ["leaseToken", "handoff"]) ||
        typeof input.leaseToken !== "string"
      ) {
        return yield* Effect.fail(
          serverError("request_failed", "typed harness handoff is required"),
        )
      }
      const handoff = yield* Effect.mapError(
        decodeHarnessReviewHandoff(input.handoff),
        () => serverError("request_failed", "harness handoff is invalid"),
      )
      if (
        !harnessHandoffMatchesAttempt(
          handoff,
          current.spec.payload,
          current.id,
          current.attempt,
        )
      ) {
        return yield* Effect.fail(
          serverError("request_failed", "harness handoff does not match the live attempt"),
        )
      }
      if (handoff.status === "blocked" || handoff.status === "failed") {
        return yield* Effect.fail(
          serverError("request_failed", "unsuccessful harness handoff cannot complete a job"),
        )
      }
      const job = yield* store.complete(
        id,
        input.leaseToken,
        Date.now(),
        `harness ${handoff.status}: ${handoff.assessment}`,
        { kind: "harness.review", handoff },
      )
      sendJson(response, 200, { job })
      return
    }
    if (
      !isRecord(input) ||
      !exactKeys(input, ["leaseToken", "summary"]) ||
      typeof input.leaseToken !== "string" ||
      typeof input.summary !== "string"
    ) {
      return yield* Effect.fail(
        serverError("request_failed", "job completion payload is invalid"),
      )
    }
    const job = yield* store.complete(
      id,
      input.leaseToken,
      Date.now(),
      input.summary,
    )
    sendJson(response, 200, { job })
  })
}

const handleFail = (
  id: string,
  request: IncomingMessage,
  response: ServerResponse,
  store: SqliteJobStore,
): Effect.Effect<void, unknown> => {
  if (request.method !== "POST") {
    sendError(response, 405, "method_not_allowed", "method is not allowed")
    return Effect.void
  }
  if (!hasJsonContentType(request)) {
    sendError(response, 415, "unsupported_media_type", "application/json is required")
    return Effect.void
  }
  return Effect.gen(function* () {
    const input = yield* Effect.flatMap(readBody(request), parseJson)
    if (
      !isRecord(input) ||
      !exactKeys(input, ["leaseToken", "retryDelayMs", "summary"]) ||
      typeof input.leaseToken !== "string" ||
      typeof input.retryDelayMs !== "number" ||
      typeof input.summary !== "string"
    ) {
      return yield* Effect.fail(
        serverError("request_failed", "job failure payload is invalid"),
      )
    }
    const job = yield* store.fail(
      id,
      input.leaseToken,
      Date.now(),
      input.retryDelayMs,
      input.summary,
    )
    sendJson(response, 200, { job })
  })
}

const dashboardAssets: Readonly<Record<string, readonly [string, string]>> = {
  "/": ["index.html", "text/html; charset=utf-8"],
  "/app.js": ["app.js", "text/javascript; charset=utf-8"],
  "/app.css": ["app.css", "text/css; charset=utf-8"],
}

const handleDashboard = (
  path: string,
  request: IncomingMessage,
  response: ServerResponse,
  directory: string,
): Effect.Effect<boolean, ControlPlaneServerError> => {
  const asset = dashboardAssets[path]
  if (!asset) return Effect.succeed(false)
  if (request.method !== "GET") {
    sendError(response, 405, "method_not_allowed", "method is not allowed")
    return Effect.succeed(true)
  }
  return Effect.map(
    Effect.tryPromise({
      try: () => readFile(join(directory, asset[0])),
      catch: () =>
        serverError("request_failed", "dashboard asset could not be read"),
    }),
    (body) => {
      sendAsset(response, asset[1], body)
      return true
    },
  )
}

const handleRequest = (
  request: IncomingMessage,
  response: ServerResponse,
  store: SqliteJobStore,
  dashboardDirectory?: string,
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
      if (path === "/v1/worker/claim")
        return handleClaim(request, response, store)
      const completeMatch = /^\/v1\/jobs\/([A-Za-z0-9][A-Za-z0-9:._-]{0,127})\/complete$/u.exec(path)
      if (completeMatch?.[1])
        return handleComplete(completeMatch[1], request, response, store)
      const failMatch = /^\/v1\/jobs\/([A-Za-z0-9][A-Za-z0-9:._-]{0,127})\/fail$/u.exec(path)
      if (failMatch?.[1]) return handleFail(failMatch[1], request, response, store)
      if (dashboardDirectory) {
        return Effect.flatMap(
          handleDashboard(path, request, response, dashboardDirectory),
          (handled) => {
            if (!handled)
              sendError(response, 404, "not_found", "route was not found")
            return Effect.void
          },
        )
      }
      sendError(response, 404, "not_found", "route was not found")
      return Effect.void
    }),
    (error) => internalFailure(response, error),
  )
}

export const startControlPlaneServer = (
  options: ControlPlaneServerOptions,
): Effect.Effect<RunningControlPlaneServer, ControlPlaneServerError> => {
  if (options.host !== LOOPBACK_HOSTS[0] && options.host !== LOOPBACK_HOSTS[1]) {
    return Effect.fail(
      serverError("invalid_bind", "control plane must bind to a loopback address"),
    )
  }
  if (!Number.isSafeInteger(options.port) || options.port < 0 || options.port > 65_535) {
    return Effect.fail(
      serverError("invalid_bind", "control plane port must be between 0 and 65535"),
    )
  }
  if (
    options.dashboardDirectory !== undefined &&
    (!isAbsolute(options.dashboardDirectory) ||
      options.dashboardDirectory.length > 1_024)
  ) {
    return Effect.fail(
      serverError(
        "invalid_dashboard",
        "dashboard directory must be a bounded absolute path",
      ),
    )
  }

  return Effect.async((resume) => {
    const server = createServer((request, response) => {
      void Effect.runPromise(
        handleRequest(
          request,
          response,
          options.store,
          options.dashboardDirectory,
        ),
      )
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
