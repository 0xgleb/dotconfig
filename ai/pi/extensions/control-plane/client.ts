import { Data, Effect } from "effect"
import type { HarnessReviewHandoff } from "./harness-protocol.ts"
import {
  decodeStoredJob,
  type Job,
  type RegisteredJobKind,
  type RegisteredJobSpec,
} from "./job-runtime.ts"

export interface ControlPlaneHealth {
  readonly status: "ok"
  readonly protocolVersion: number
  readonly schemaVersion: number
}

export interface ControlPlaneClaimOptions {
  readonly workerId: string
  readonly ttlMs: number
  readonly kinds?: readonly RegisteredJobKind[]
  readonly idempotencyKeys?: readonly string[]
}

export type ControlPlaneCompletion =
  | { readonly summary: string }
  | { readonly handoff: HarnessReviewHandoff }

export interface ControlPlaneEnqueueResult {
  readonly job: Job
  readonly created: boolean
}

export interface ControlPlaneClient {
  readonly health: () => Effect.Effect<
    ControlPlaneHealth,
    ControlPlaneClientError
  >
  readonly enqueue: (
    spec: RegisteredJobSpec,
  ) => Effect.Effect<ControlPlaneEnqueueResult, ControlPlaneClientError>
  readonly claimDue: (
    options: ControlPlaneClaimOptions,
  ) => Effect.Effect<Job | undefined, ControlPlaneClientError>
  readonly complete: (
    id: string,
    leaseToken: string,
    completion: ControlPlaneCompletion,
  ) => Effect.Effect<Job, ControlPlaneClientError>
  readonly fail: (
    id: string,
    leaseToken: string,
    retryDelayMs: number,
    summary: string,
  ) => Effect.Effect<Job, ControlPlaneClientError>
  readonly list: () => Effect.Effect<readonly Job[], ControlPlaneClientError>
}

export class ControlPlaneClientError extends Data.TaggedError(
  "ControlPlaneClientError",
)<{
  readonly code: "request_failed" | "rejected" | "invalid_response"
  readonly message: string
}> {}

export const makeControlPlaneClient = (origin: string): ControlPlaneClient => ({
  health: () =>
    Effect.flatMap(requestJson(origin, "GET", "/v1/health"), (response) =>
      isRecord(response.body) &&
      response.body.status === "ok" &&
      typeof response.body.protocolVersion === "number" &&
      typeof response.body.schemaVersion === "number"
        ? Effect.succeed({
            status: "ok" as const,
            protocolVersion: response.body.protocolVersion,
            schemaVersion: response.body.schemaVersion,
          })
        : invalidResponse("health response is malformed"),
    ),
  enqueue: (spec) =>
    Effect.flatMap(
      requestJson(origin, "POST", "/v1/jobs", spec),
      (response) =>
        Effect.map(decodeJobField(response.body), (job) => ({
          job,
          created: response.status === 201,
        })),
    ),
  claimDue: (options) =>
    Effect.flatMap(
      requestJson(origin, "POST", "/v1/worker/claim", {
        workerId: options.workerId,
        ttlMs: options.ttlMs,
        ...(options.kinds ? { kinds: options.kinds } : {}),
        ...(options.idempotencyKeys
          ? { idempotencyKeys: options.idempotencyKeys }
          : {}),
      }),
      (response) =>
        response.status === 204
          ? Effect.succeed(undefined)
          : decodeJobField(response.body),
    ),
  complete: (id, leaseToken, completion) =>
    Effect.flatMap(validateJobPath(id, leaseToken), (jobId) =>
      Effect.flatMap(
        requestJson(origin, "POST", `/v1/jobs/${jobId}/complete`, {
          leaseToken,
          ...completion,
        }),
        (response) => decodeJobField(response.body),
      ),
    ),
  fail: (id, leaseToken, retryDelayMs, summary) =>
    Effect.flatMap(validateJobPath(id, leaseToken), (jobId) =>
      Effect.flatMap(
        requestJson(origin, "POST", `/v1/jobs/${jobId}/fail`, {
          leaseToken,
          retryDelayMs,
          summary,
        }),
        (response) => decodeJobField(response.body),
      ),
    ),
  list: () =>
    Effect.flatMap(requestJson(origin, "GET", "/v1/jobs"), (response) =>
      isRecord(response.body) && Array.isArray(response.body.jobs)
        ? Effect.forEach(response.body.jobs, decodeJob)
        : invalidResponse("job list response is malformed"),
    ),
})

const SAFE_PATH_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/u

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const clientError = (
  code: ControlPlaneClientError["code"],
  message: string,
): ControlPlaneClientError => new ControlPlaneClientError({ code, message })

const invalidResponse = <A>(
  message: string,
): Effect.Effect<A, ControlPlaneClientError> =>
  Effect.fail(clientError("invalid_response", message))

const validateJobPath = (
  id: string,
  leaseToken: string,
): Effect.Effect<string, ControlPlaneClientError> =>
  SAFE_PATH_SEGMENT.test(id) && SAFE_PATH_SEGMENT.test(leaseToken)
    ? Effect.succeed(id)
    : Effect.fail(
        clientError("rejected", "job id and lease token must be bounded"),
      )

interface ClientResponse {
  readonly status: number
  readonly body: unknown
}

const requestJson = (
  origin: string,
  method: "GET" | "POST",
  path: string,
  body?: unknown,
): Effect.Effect<ClientResponse, ControlPlaneClientError> =>
  Effect.flatMap(
    Effect.tryPromise({
      try: () =>
        fetch(`${origin}${path}`, {
          method,
          ...(body === undefined
            ? {}
            : {
                headers: { "content-type": "application/json" },
                body: JSON.stringify(body),
              }),
        }),
      catch: () =>
        clientError("request_failed", `control plane request to ${path} failed`),
    }),
    (response) => {
      if (response.status === 204)
        return Effect.succeed({ status: 204, body: undefined })
      if (response.status !== 200 && response.status !== 201) {
        return Effect.fail(
          clientError(
            "rejected",
            `control plane rejected ${path} with status ${String(response.status)}`,
          ),
        )
      }
      return Effect.map(
        Effect.tryPromise({
          try: () => response.json() as Promise<unknown>,
          catch: () =>
            clientError(
              "invalid_response",
              `control plane response from ${path} is not JSON`,
            ),
        }),
        (parsed) => ({ status: response.status, body: parsed }),
      )
    },
  )

const decodeJob = (value: unknown): Effect.Effect<Job, ControlPlaneClientError> =>
  Effect.mapError(decodeStoredJob(value), () =>
    clientError("invalid_response", "control plane returned a malformed job"),
  )

const decodeJobField = (
  body: unknown,
): Effect.Effect<Job, ControlPlaneClientError> =>
  isRecord(body)
    ? decodeJob(body.job)
    : invalidResponse("control plane response is missing its job")
