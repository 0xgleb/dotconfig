import { randomUUID } from "node:crypto"
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http"
import { readFile } from "node:fs/promises"
import { isAbsolute, join } from "node:path"
import { Clock, Data, Effect } from "effect"
import { decodeHarnessReviewHandoff } from "./harness-protocol.ts"
import { decodeJobSpec, JobRuntimeError, type Job } from "./job-runtime.ts"
import type { CanonicalPath } from "./review-duty-profile.ts"
import {
  isRegisteredKindFilter,
  JobStoreError,
  type SqliteJobStore,
  type StoredJob,
} from "./sqlite-job-store.ts"

export const CONTROL_PLANE_PROTOCOL_VERSION = 1
export const CONTROL_PLANE_SCHEMA_VERSION = 1
const MAX_REQUEST_BODY_BYTES = 16 * 1_024
const LOOPBACK_HOSTS = ["127.0.0.1", "::1"] as const

/** Delay before an unsuccessful harness attempt becomes claimable again. */
const HARNESS_RETRY_DELAY_MS = 5 * 60 * 1_000

export class ControlPlaneServerError extends Data.TaggedError(
  "ControlPlaneServerError",
)<{
  readonly code:
    | "invalid_bind"
    | "invalid_json"
    | "body_too_large"
    | "invalid_payload"
    | "request_failed"
    | "listen_failed"
    | "invalid_dashboard"
  readonly message: string
}> {}

/**
 * Every failure a request handler can produce. Naming the union keeps the
 * translator below exhaustive, so a new failure mode cannot reach a client
 * without being given a status here.
 */
export type ControlPlaneFailure =
  | ControlPlaneServerError
  | JobRuntimeError
  | JobStoreError

/**
 * The store operations a request can reach. Naming them keeps the routes
 * honest about what they touch — cancellation, recovery and the raw database
 * are not among them — and lets a caller supply exactly those.
 */
export type ControlPlaneJobStore = Pick<
  SqliteJobStore,
  "enqueue" | "get" | "list" | "claimDue" | "complete" | "fail"
>

export interface ControlPlaneServerOptions {
  readonly host: string
  readonly port: number
  readonly store: ControlPlaneJobStore
  /** Home the harness payloads of enqueued jobs are admitted against. */
  readonly home: CanonicalPath
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

const sendRequestFailure = (
  response: ServerResponse,
  failure: ControlPlaneServerError,
): Effect.Effect<void> =>
  Effect.sync(() => {
    if (failure.code === "body_too_large")
      sendError(response, 413, "body_too_large", "request body is too large")
    else if (failure.code === "invalid_json")
      sendError(response, 400, "invalid_json", "request body is malformed JSON")
    else if (failure.code === "invalid_payload")
      sendError(response, 400, "invalid_input", "request payload is invalid")
    else sendError(response, 400, "invalid_request", "request could not be read")
  })

const sendRuntimeFailure = (
  response: ServerResponse,
  failure: JobRuntimeError,
): Effect.Effect<void> =>
  Effect.sync(() => {
    if (failure.code === "invalid_input")
      sendError(response, 400, "invalid_input", "job request is invalid")
    else if (failure.code === "stale_lease")
      sendError(response, 409, "stale_lease", "job lease is stale")
    else sendError(response, 409, "invalid_transition", "job state has changed")
  })

const sendStoreFailure = (
  response: ServerResponse,
  failure: JobStoreError,
): Effect.Effect<void> =>
  Effect.sync(() => {
    if (failure.code === "not_found")
      sendError(response, 404, "not_found", "job was not found")
    else if (failure.code === "idempotency_conflict")
      sendError(response, 409, "idempotency_conflict", "job key conflicts with existing input")
    else if (failure.code === "capacity")
      sendError(response, 503, "capacity", "job store is at capacity")
    else sendError(response, 500, "internal_error", "control plane request failed")
  })

/**
 * Reports the stored jobs and enqueues new ones. A job whose stored document
 * no longer decodes is listed separately by identifier and reason instead of
 * failing the read, so one unreadable row cannot blank the dashboard.
 */
const handleJobs = (
  request: IncomingMessage,
  response: ServerResponse,
  store: ControlPlaneJobStore,
  home: CanonicalPath,
): Effect.Effect<void, ControlPlaneFailure> => {
  if (request.method === "GET") {
    return Effect.flatMap(store.list(), (stored) =>
      Effect.sync(() =>
        sendJson(response, 200, {
          jobs: stored.flatMap(readableJob),
          unreadable: stored.flatMap(unreadableJob),
        }),
      ),
    )
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
    const spec = yield* decodeJobSpec(input, home)
    const result = yield* store.enqueue(spec)
    sendJson(response, result.created ? 201 : 200, { job: result.job })
  })
}

/** A job the store holds but can no longer read, as the API reports it. */
interface UnreadableJobReport {
  readonly id: string
  readonly reason: string
}

const readableJob = (stored: StoredJob): readonly Job[] =>
  stored.outcome === "readable" ? [stored.job] : []

const unreadableJob = (stored: StoredJob): readonly UnreadableJobReport[] =>
  stored.outcome === "unreadable"
    ? [{ id: stored.id, reason: stored.reason }]
    : []

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
  store: ControlPlaneJobStore,
): Effect.Effect<void, ControlPlaneFailure> => {
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
      !(
        exactKeys(input, ["workerId", "ttlMs"]) ||
        exactKeys(input, ["workerId", "ttlMs", "kinds"])
      ) ||
      typeof input.workerId !== "string" ||
      typeof input.ttlMs !== "number" ||
      ("kinds" in input &&
        (!Array.isArray(input.kinds) ||
          !isRegisteredKindFilter(input.kinds)))
    ) {
      return yield* Effect.fail(
        serverError("invalid_payload", "worker claim payload is invalid"),
      )
    }
    const now = yield* Clock.currentTimeMillis
    const job = yield* store.claimDue(
      input.workerId,
      randomUUID(),
      now,
      input.ttlMs,
      "kinds" in input && Array.isArray(input.kinds) && isRegisteredKindFilter(input.kinds)
        ? input.kinds
        : undefined,
    )
    if (job === undefined) response.writeHead(204).end()
    else sendJson(response, 200, { job })
  })
}

/**
 * Publishes what a leased worker reports. The handler owns only the request
 * shape: which transition a harness handoff drives, and whether it belongs to
 * the live attempt, is decided by the job runtime inside the store
 * transaction, so its typed failures pick the response status. The reply is
 * the record the transition produced, so a blocked attempt that still has
 * retries answers with the retrying job and the summary it was left with,
 * rather than reading as a finished one.
 */
const handleComplete = (
  id: string,
  request: IncomingMessage,
  response: ServerResponse,
  store: ControlPlaneJobStore,
): Effect.Effect<void, ControlPlaneFailure> => {
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
          serverError("invalid_payload", "typed harness handoff is required"),
        )
      }
      const handoff = yield* Effect.mapError(
        decodeHarnessReviewHandoff(input.handoff),
        // The decoder names the field an untrusted caller got wrong, so the
        // reply stays generic; the job runtime keeps the detail internally.
        () => serverError("invalid_payload", "harness handoff is invalid"),
      )
      const leaseToken = input.leaseToken
      const summary = `harness ${handoff.status}: ${handoff.assessment}`
      const result = { kind: "harness.review" as const, handoff }
      // Sampled against the transaction it is handed to, so a cancellation
      // that commits while the handoff is being decoded cannot make this
      // timestamp precede the state the transaction reads.
      const now = yield* Clock.currentTimeMillis
      const publish =
        handoff.status === "blocked" || handoff.status === "failed"
          ? store.fail(id, leaseToken, now, HARNESS_RETRY_DELAY_MS, summary, result)
          : store.complete(id, leaseToken, now, summary, result)
      const job = yield* publish
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
        serverError("invalid_payload", "job completion payload is invalid"),
      )
    }
    const now = yield* Clock.currentTimeMillis
    const job = yield* store.complete(id, input.leaseToken, now, input.summary)
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
  store: ControlPlaneJobStore,
  home: CanonicalPath,
  dashboardDirectory?: string,
): Effect.Effect<void> => {
  const route: Effect.Effect<string, ControlPlaneFailure> = Effect.try({
    try: () => new URL(request.url ?? "/", "http://127.0.0.1").pathname,
    catch: () => serverError("request_failed", "request URL is malformed"),
  })
  return Effect.catchTags(
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
      if (path === "/v1/jobs")
        return handleJobs(request, response, store, home)
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
    {
      ControlPlaneServerError: (failure) =>
        sendRequestFailure(response, failure),
      JobRuntimeError: (failure) => sendRuntimeFailure(response, failure),
      JobStoreError: (failure) => sendStoreFailure(response, failure),
    },
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
          options.home,
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
      const address = server.address()
      if (address === null || typeof address === "string") {
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
