import { randomUUID } from "node:crypto"
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http"
import { readFile } from "node:fs/promises"
import type { AddressInfo } from "node:net"
import { isAbsolute, join } from "node:path"
import { Data, Effect, Either } from "effect"
import { sampleCodexWeeklyAllowance } from "./codex-allowance.ts"
import { ThrottleActivity } from "./throttle-activity.ts"
import {
  decodeHarnessReviewHandoff,
  harnessHandoffMatchesAttempt,
} from "./harness-protocol.ts"
import {
  decodeHarnessResearchHandoff,
  harnessResearchHandoffMatchesAttempt,
  validateNewHarnessResearchPayload,
} from "./harness-research-protocol.ts"
import { decodeJobSpec, JobRuntimeError } from "./job-runtime.ts"
import type { RegistryStore } from "../agent-registry/registry.ts"
import type { RemoteBridgeStore } from "../remote-control/sqlite-store.ts"
import {
  governedAllowanceCheckpoints,
  isAllowancePool,
  providerCallAllowanceCheckpoints,
  isAllowanceSource,
  type AllowancePool,
  type ProviderAllowanceCheckpoint,
} from "./allowance-pool.ts"
import {
  agentAllocation,
  allowanceRunway,
  calibrateProviderTokens,
  isAutonomousRole,
  MIN_WORKFLOW_TOKEN_BUDGET,
  providerTokenPolicy,
  rolePollingPolicy,
  usagePolicy,
  WEEK_MS,
  workflowTokenBudget,
  type AutonomousRole,
  type ProviderUsagePoint,
} from "./usage-policy.ts"
import {
  isRegisteredKindFilter,
  JobStoreError,
  type SqliteJobStore,
} from "./sqlite-job-store.ts"

export const CONTROL_PLANE_PROTOCOL_VERSION = 1
export const CONTROL_PLANE_SCHEMA_VERSION = 6
const MAX_REQUEST_BODY_BYTES = 16 * 1_024
const LOOPBACK_HOSTS = ["127.0.0.1", "::1"] as const
const USAGE_SAMPLE_INTERVAL_MS = 60_000
const CODEX_ALLOWANCE_SAMPLE_INTERVAL_MS = 15 * 60_000
const USAGE_HISTORY_WINDOW_MS = 7 * 24 * 60 * 60 * 1_000
const MAX_RESEARCH_SCHEDULE_SKEW_MS = 7 * 24 * 60 * 60 * 1_000
const OPENAI_AUTONOMOUS_ROLES: readonly AutonomousRole[] = [
  "general",
  "reviewer",
  "yielduck-operator",
  "moneymentum-operator",
]

const openAiControlCheckpoints = (
  checkpoints: readonly ProviderAllowanceCheckpoint[],
  now: number,
): readonly ProviderAllowanceCheckpoint[] => {
  const providerCheckpoints = providerCallAllowanceCheckpoints(
    checkpoints,
    "openai",
  )
  const manualCheckpoints = providerCheckpoints.filter(
    checkpoint => checkpoint.source === "manual",
  )
  if (allowanceRunway(manualCheckpoints, now)) return manualCheckpoints
  const observedCheckpoints = providerCheckpoints.filter(
    checkpoint => checkpoint.source === "codex-app-server",
  )
  return allowanceRunway(observedCheckpoints, now)
    ? observedCheckpoints
    : governedAllowanceCheckpoints(checkpoints)
}

const openAiControlSnapshot = (
  checkpoints: readonly ProviderAllowanceCheckpoint[],
  samples: readonly ProviderUsagePoint[],
  now: number,
  activity: ThrottleActivity,
) => {
  const controlCheckpoints = openAiControlCheckpoints(checkpoints, now)
  const latest = controlCheckpoints.toSorted(
    (left, right) => right.capturedAt - left.capturedAt,
  )[0]
  const policy = usagePolicy(controlCheckpoints, now)
  const calibration = calibrateProviderTokens(controlCheckpoints, samples)
  const providerBudget = providerTokenPolicy(policy, calibration)
  return {
    computedAt: now,
    provider: "openai" as const,
    pool: latest?.pool ?? "chatgpt-shared-weekly",
    source: latest?.source ?? "unavailable",
    profile: {
      kind: "flat-until-reset" as const,
      participants: 1,
    },
    policy,
    ...(calibration ? { calibration } : {}),
    ...(providerBudget ? { providerBudget } : {}),
    roles: OPENAI_AUTONOMOUS_ROLES.map(role =>
      rolePollingPolicy(role, policy.pace, policy.throttleRatio),
    ),
    activity: activity.snapshot(now),
  }
}

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
  readonly registryStore?: RegistryStore
  readonly bridgeStore?: RemoteBridgeStore
  readonly dashboardDirectory?: string
  readonly codexExecutable?: string
}

interface UsageSamplingStatus {
  status: "unavailable" | "sampling" | "ok" | "error"
  lastAttemptAt?: number
  lastCapturedAt?: number
  error?: "registry" | "store"
  allowance: {
    status: "unavailable" | "sampling" | "ok" | "error"
    lastAttemptAt?: number
    lastCapturedAt?: number
    error?: "provider" | "store"
  }
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
    "content-security-policy":
      "default-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
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
  Effect.async(resume => {
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

const parseJson = (
  body: string,
): Effect.Effect<unknown, ControlPlaneServerError> =>
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
    else
      sendError(response, 400, "invalid_request", "request could not be read")
    return Effect.void
  }
  if (error instanceof JobRuntimeError) {
    if (error.code === "invalid_input")
      sendError(response, 400, "invalid_input", "job request is invalid")
    else if (error.code === "stale_lease")
      sendError(response, 409, "stale_lease", "job lease is stale")
    else sendError(response, 409, "invalid_transition", "job state has changed")
    return Effect.void
  }
  if (error instanceof JobStoreError) {
    if (error.code === "invalid_input")
      sendError(response, 400, "invalid_input", "request input is invalid")
    else if (error.code === "idempotency_conflict")
      sendError(
        response,
        409,
        "idempotency_conflict",
        "job key conflicts with existing input",
      )
    else if (error.code === "not_found")
      sendError(response, 404, "not_found", "resource was not found")
    else if (error.code === "capacity")
      sendError(response, 503, "capacity", "job store is at capacity")
    else
      sendError(response, 500, "internal_error", "control plane request failed")
    return Effect.void
  }
  sendError(response, 500, "internal_error", "control plane request failed")
  return Effect.void
}

const ZERO_TOKEN_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
} as const

const handleAgents = (
  request: IncomingMessage,
  response: ServerResponse,
  registryStore: RegistryStore | undefined,
  bridgeStore: RemoteBridgeStore | undefined,
): Effect.Effect<void, unknown> => {
  if (request.method !== "GET") {
    sendError(response, 405, "method_not_allowed", "method is not allowed")
    return Effect.void
  }
  const now = Date.now()
  return Effect.map(
    Effect.all({
      registry: registryStore
        ? registryStore.snapshot(now)
        : Effect.succeed({ agents: [], leases: [] } as const),
      bridge: bridgeStore ? bridgeStore.listAgents(now) : Effect.succeed([]),
    }),
    ({ registry, bridge }) => {
      const nativeAgents = (registry.agents ?? []).map(agent => ({
        id: agent.identity.id,
        presence: "runtime" as const,
        label: agent.label,
        cwd: agent.cwd,
        ...(agent.identity.model ? { model: agent.identity.model } : {}),
        usage: agent.usage,
        activities: agent.activities ?? [],
        roles: registry.leases
          .filter(
            lease =>
              lease.owner.id === agent.identity.id && lease.status === "active",
          )
          .map(({ project, role, mode }) => ({ project, role, mode })),
        heartbeatAt: agent.heartbeatAt,
        expiresAt: agent.expiresAt,
      }))
      const nativeIds = new Set(nativeAgents.map(({ id }) => id))
      const externalAgents = bridge
        .filter(({ id }) => !nativeIds.has(id))
        .map(agent => ({
          id: agent.id,
          // A bridge heartbeat proves only that its registration watcher is
          // alive. It does not prove the named harness pane still exists.
          presence: "bridge-endpoint" as const,
          label: agent.label,
          cwd: agent.cwd,
          usage: ZERO_TOKEN_USAGE,
          activities: [],
          roles: [],
          heartbeatAt: agent.heartbeatAt,
          expiresAt: agent.expiresAt,
        }))
      sendJson(response, 200, { agents: [...nativeAgents, ...externalAgents] })
    },
  )
}

const handleUsage = (
  request: IncomingMessage,
  response: ServerResponse,
  store: SqliteJobStore,
  sampling: UsageSamplingStatus,
  activity: ThrottleActivity,
): Effect.Effect<void, unknown> => {
  const now = Date.now()
  const since = Math.max(0, now - USAGE_HISTORY_WINDOW_MS)
  if (request.method === "GET")
    return Effect.map(
      Effect.all({
        samples: store.listUsage(since),
        checkpoints: store.listAllowanceCheckpoints(since),
      }),
      ({ samples, checkpoints }) =>
        sendJson(response, 200, {
          samples,
          checkpoints,
          sampling,
          control: openAiControlSnapshot(checkpoints, samples, now, activity),
        }),
    )
  if (request.method !== "POST") {
    sendError(response, 405, "method_not_allowed", "method is not allowed")
    return Effect.void
  }
  const contentType = request.headers["content-type"]?.split(";", 1)[0]?.trim()
  if (contentType !== "application/json") {
    sendError(
      response,
      415,
      "unsupported_media_type",
      "application/json is required",
    )
    return Effect.void
  }
  return Effect.gen(function* () {
    const body = yield* readBody(request)
    const input = yield* parseJson(body)
    const isRefill =
      isRecord(input) &&
      exactKeys(input, [
        "provider",
        "pool",
        "source",
        "capturedAt",
        "remainingPercent",
        "event",
      ]) &&
      input.event === "refill"
    const isSample =
      isRecord(input) &&
      exactKeys(input, [
        "provider",
        "pool",
        "source",
        "capturedAt",
        "remainingPercent",
        "resetAt",
      ]) &&
      typeof input.resetAt === "number"
    if (
      !isRecord(input) ||
      (!isRefill && !isSample) ||
      !isAllowancePool(input.provider, input.pool) ||
      !isAllowanceSource(input.source) ||
      typeof input.capturedAt !== "number" ||
      typeof input.remainingPercent !== "number"
    ) {
      return yield* Effect.fail(
        new JobStoreError({
          code: "invalid_input",
          message: "allowance checkpoint shape is invalid",
        }),
      )
    }
    const checkpoint = yield* store.recordAllowanceCheckpoint({
      provider: input.provider,
      pool: input.pool as AllowancePool,
      source: input.source,
      capturedAt: input.capturedAt,
      remainingPercent: input.remainingPercent,
      ...(isRefill
        ? { event: "refill" as const }
        : { resetAt: input.resetAt as number }),
    })
    sendJson(response, 201, { checkpoint })
  })
}

const handleUsageControl = (
  request: IncomingMessage,
  response: ServerResponse,
  store: SqliteJobStore,
  url: URL,
  activity: ThrottleActivity,
): Effect.Effect<void, unknown> => {
  if (request.method !== "GET") {
    sendError(response, 405, "method_not_allowed", "method is not allowed")
    return Effect.void
  }
  const agentId = url.searchParams.get("agentId")
  const cwd = url.searchParams.get("cwd")
  if (
    (agentId === null) !== (cwd === null) ||
    (agentId !== null && (agentId.length < 1 || agentId.length > 160)) ||
    (cwd !== null && (cwd.length < 1 || cwd.length > 1_024 || !isAbsolute(cwd)))
  ) {
    sendError(
      response,
      400,
      "invalid_input",
      "agent throttle identity is invalid",
    )
    return Effect.void
  }
  const now = Date.now()
  const since = Math.max(0, now - USAGE_HISTORY_WINDOW_MS)
  return Effect.gen(function* () {
    const { samples, checkpoints } = yield* Effect.all({
      samples: store.listUsage(since),
      checkpoints: store.listAllowanceCheckpoints(since),
    })
    const allocation =
      agentId === null || cwd === null
        ? undefined
        : agentAllocation(cwd, yield* store.agentIntervention(agentId), now)
    sendJson(response, 200, {
      ...openAiControlSnapshot(checkpoints, samples, now, activity),
      ...(allocation ? { allocation } : {}),
    })
  })
}

const handleUsageAdmission = (
  request: IncomingMessage,
  response: ServerResponse,
  store: SqliteJobStore,
  url: URL,
  activity: ThrottleActivity,
): Effect.Effect<void, unknown> => {
  if (request.method !== "POST") {
    sendError(response, 405, "method_not_allowed", "method is not allowed")
    return Effect.void
  }
  const role = url.searchParams.get("role")
  if (!isAutonomousRole(role)) {
    sendError(response, 400, "invalid_input", "autonomous role is invalid")
    return Effect.void
  }
  const now = Date.now()
  return Effect.gen(function* () {
    const checkpoints = yield* store.listAllowanceCheckpoints(
      Math.max(0, now - USAGE_HISTORY_WINDOW_MS),
    )
    const policy = usagePolicy(openAiControlCheckpoints(checkpoints, now), now)
    const rolePolling = rolePollingPolicy(
      role,
      policy.pace,
      policy.throttleRatio,
    )
    const kind = url.searchParams.get("kind") ?? "turn"
    if (kind === "workflow") {
      const requestedTokens = Number(url.searchParams.get("requestedTokens"))
      if (
        !Number.isSafeInteger(requestedTokens) ||
        requestedTokens < MIN_WORKFLOW_TOKEN_BUDGET ||
        requestedTokens > 5_000_000
      ) {
        sendError(
          response,
          400,
          "invalid_input",
          "workflow token request is invalid",
        )
        return
      }
      const budget = workflowTokenBudget(requestedTokens, rolePolling)
      const retryAt = Math.min(
        policy.resetAt ?? now + rolePolling.effectiveIntervalMs,
        now + rolePolling.effectiveIntervalMs,
      )
      activity.record({
        at: now,
        kind: "workflow",
        outcome: budget.allowed
          ? budget.grantedTokens < requestedTokens
            ? "scaled"
            : "admitted"
          : "deferred",
        role,
        requestedTokens,
        grantedTokens: budget.grantedTokens,
        ...(budget.allowed ? {} : { retryAt }),
      })
      sendJson(response, 200, {
        admission: budget.allowed
          ? {
              allowed: true,
              admittedAt: now,
              grantedTokens: budget.grantedTokens,
              policy: { ...policy, rolePolling },
            }
          : {
              allowed: false,
              retryAt,
              grantedTokens: 0,
              policy: { ...policy, rolePolling },
            },
      })
      return
    }
    if (kind !== "turn" || url.searchParams.has("requestedTokens")) {
      sendError(
        response,
        400,
        "invalid_input",
        "usage admission kind is invalid",
      )
      return
    }
    if (policy.throttleRatio === 0) {
      const retryAt = policy.resetAt ?? now + WEEK_MS
      activity.record({
        at: now,
        kind: "turn",
        outcome: "deferred",
        role,
        retryAt,
      })
      sendJson(response, 200, {
        admission: {
          allowed: false,
          retryAt,
          policy: { ...policy, rolePolling },
        },
      })
      return
    }
    const admission = yield* store.claimAutonomousAdmission(
      role,
      now,
      policy.minimumIntervalMs,
      rolePolling.effectiveIntervalMs,
    )
    activity.record({
      at: now,
      kind: "turn",
      outcome: admission.allowed ? "admitted" : "deferred",
      role,
      ...(admission.allowed ? {} : { retryAt: admission.retryAt }),
    })
    sendJson(response, 200, {
      admission: { ...admission, policy: { ...policy, rolePolling } },
    })
  })
}

const handleOwnerIntervention = (
  request: IncomingMessage,
  response: ServerResponse,
  store: SqliteJobStore,
): Effect.Effect<void, unknown> => {
  if (request.method !== "POST") {
    sendError(response, 405, "method_not_allowed", "method is not allowed")
    return Effect.void
  }
  if (!hasJsonContentType(request)) {
    sendError(
      response,
      415,
      "unsupported_media_type",
      "application/json is required",
    )
    return Effect.void
  }
  return Effect.gen(function* () {
    const input = yield* parseJson(yield* readBody(request))
    const now = Date.now()
    if (
      !isRecord(input) ||
      !exactKeys(input, ["targetAgentId", "targetCwd", "ownerInteractionAt"]) ||
      typeof input.targetAgentId !== "string" ||
      input.targetAgentId.length < 1 ||
      input.targetAgentId.length > 160 ||
      typeof input.targetCwd !== "string" ||
      input.targetCwd.length < 1 ||
      input.targetCwd.length > 1_024 ||
      !isAbsolute(input.targetCwd) ||
      typeof input.ownerInteractionAt !== "number" ||
      !Number.isSafeInteger(input.ownerInteractionAt) ||
      input.ownerInteractionAt < 0 ||
      input.ownerInteractionAt > now
    )
      return yield* Effect.fail(
        new JobStoreError({
          code: "invalid_input",
          message: "owner intervention shape is invalid",
        }),
      )
    yield* store.recordAgentIntervention({
      agentId: input.targetAgentId,
      cwd: input.targetCwd,
      ownerInteractionAt: input.ownerInteractionAt,
    })
    sendJson(response, 200, { recorded: true })
  })
}

const handleProviderCallReservation = (
  request: IncomingMessage,
  response: ServerResponse,
  store: SqliteJobStore,
  activity: ThrottleActivity,
): Effect.Effect<void, unknown> => {
  if (request.method !== "POST") {
    sendError(response, 405, "method_not_allowed", "method is not allowed")
    return Effect.void
  }
  if (!hasJsonContentType(request)) {
    sendError(
      response,
      415,
      "unsupported_media_type",
      "application/json is required",
    )
    return Effect.void
  }
  return Effect.gen(function* () {
    const input = yield* parseJson(yield* readBody(request))
    if (
      !isRecord(input) ||
      !exactKeys(input, [
        "reservationId",
        "agentId",
        "cwd",
        "role",
        "provider",
        "requestedTokens",
        "lane",
        "ownerInteractionAt",
      ]) ||
      typeof input.reservationId !== "string" ||
      typeof input.agentId !== "string" ||
      input.agentId.length < 1 ||
      input.agentId.length > 160 ||
      typeof input.cwd !== "string" ||
      input.cwd.length < 1 ||
      input.cwd.length > 1_024 ||
      !isAbsolute(input.cwd) ||
      !isAutonomousRole(input.role) ||
      input.provider !== "openai" ||
      typeof input.requestedTokens !== "number" ||
      (input.lane !== "human" &&
        input.lane !== "responsive" &&
        input.lane !== "autonomous") ||
      (input.ownerInteractionAt !== null &&
        typeof input.ownerInteractionAt !== "number")
    )
      return yield* Effect.fail(
        new JobStoreError({
          code: "invalid_input",
          message: "provider call reservation shape is invalid",
        }),
      )
    const now = Date.now()
    if (
      (input.lane === "human" &&
        (typeof input.ownerInteractionAt !== "number" ||
          !Number.isSafeInteger(input.ownerInteractionAt) ||
          input.ownerInteractionAt < 0 ||
          input.ownerInteractionAt > now)) ||
      (input.lane !== "human" && input.ownerInteractionAt !== null)
    )
      return yield* Effect.fail(
        new JobStoreError({
          code: "invalid_input",
          message: "provider call interaction timestamp is invalid",
        }),
      )
    if (input.lane === "human" && input.ownerInteractionAt !== null)
      yield* store.recordAgentIntervention({
        agentId: input.agentId,
        cwd: input.cwd,
        ownerInteractionAt: input.ownerInteractionAt,
      })

    const checkpoints = yield* store.listAllowanceCheckpoints(
      Math.max(0, now - USAGE_HISTORY_WINDOW_MS),
    )
    const controlCheckpoints = openAiControlCheckpoints(checkpoints, now)
    const policy = usagePolicy(controlCheckpoints, now)
    const rolePolicy = rolePollingPolicy(
      input.role,
      policy.pace,
      policy.throttleRatio,
    )
    const samples = yield* store.listUsage(
      Math.max(0, now - USAGE_HISTORY_WINDOW_MS),
    )
    const calibration = calibrateProviderTokens(controlCheckpoints, samples)
    const calibratedPolicy = providerTokenPolicy(policy, calibration)
    const capacityTokens =
      calibratedPolicy?.capacityTokens ??
      workflowTokenBudget(500_000, rolePolicy).grantedTokens
    const providerBudget = {
      ...(calibratedPolicy ?? {
        capacityTokens,
        permittedTokensPerHour: 0,
        windowMs: 4 * 60 * 60 * 1_000,
      }),
      calibration,
    }
    if (capacityTokens < 1) {
      const retryAt = policy.resetAt ?? now + WEEK_MS
      activity.record({
        at: now,
        kind: "provider-call",
        outcome: "deferred",
        role: input.role,
        requestedTokens: input.requestedTokens,
        grantedTokens: 0,
        retryAt,
      })
      sendJson(response, 200, {
        reservation: {
          allowed: false,
          retryAt,
        },
        policy,
        providerBudget,
      })
      return
    }
    const minimumIntervalMs = Math.max(
      1_000,
      Math.min(
        WEEK_MS,
        providerBudget.permittedTokensPerHour > 0
          ? Math.ceil(
              (input.requestedTokens / providerBudget.permittedTokensPerHour) *
                60 *
                60 *
                1_000,
            )
          : policy.minimumIntervalMs,
      ),
    )
    const ownerInteractionAt = yield* store.agentIntervention(input.agentId)
    const allocation = agentAllocation(input.cwd, ownerInteractionAt, now)
    const reservation = yield* store.reserveProviderCall({
      reservationId: input.reservationId,
      agentId: input.agentId,
      role: input.role,
      provider: "openai",
      requestedTokens: input.requestedTokens,
      capacityTokens,
      windowMs: providerBudget.windowMs,
      minimumIntervalMs,
      allocationWeight: allocation.effectiveWeight,
      now,
    })
    if (reservation.allowed)
      activity.providerReserved(
        input.reservationId,
        input.role,
        input.requestedTokens,
        now,
      )
    else
      activity.record({
        at: now,
        kind: "provider-call",
        outcome: "deferred",
        role: input.role,
        requestedTokens: input.requestedTokens,
        grantedTokens: 0,
        retryAt: reservation.retryAt,
      })
    sendJson(response, 200, {
      reservation,
      policy,
      allocation,
      providerBudget,
    })
  })
}

const handleProviderCallSettlement = (
  request: IncomingMessage,
  response: ServerResponse,
  store: SqliteJobStore,
  activity: ThrottleActivity,
): Effect.Effect<void, unknown> => {
  if (request.method !== "POST") {
    sendError(response, 405, "method_not_allowed", "method is not allowed")
    return Effect.void
  }
  if (!hasJsonContentType(request)) {
    sendError(
      response,
      415,
      "unsupported_media_type",
      "application/json is required",
    )
    return Effect.void
  }
  return Effect.gen(function* () {
    const input = yield* parseJson(yield* readBody(request))
    if (
      !isRecord(input) ||
      !exactKeys(input, ["reservationId", "actualTokens"]) ||
      typeof input.reservationId !== "string" ||
      typeof input.actualTokens !== "number"
    )
      return yield* Effect.fail(
        new JobStoreError({
          code: "invalid_input",
          message: "provider call settlement shape is invalid",
        }),
      )
    const now = Date.now()
    const settlement = yield* store.settleProviderCall({
      reservationId: input.reservationId,
      actualTokens: input.actualTokens,
      now,
    })
    activity.providerSettled(input.reservationId, now)
    sendJson(response, 200, { settlement })
  })
}

const handleJobs = (
  request: IncomingMessage,
  response: ServerResponse,
  store: SqliteJobStore,
): Effect.Effect<void, unknown> => {
  if (request.method === "GET") {
    return Effect.map(store.list(), jobs => sendJson(response, 200, { jobs }))
  }
  if (request.method !== "POST") {
    sendError(response, 405, "method_not_allowed", "method is not allowed")
    return Effect.void
  }
  const contentType = request.headers["content-type"]?.split(";", 1)[0]?.trim()
  if (contentType !== "application/json") {
    sendError(
      response,
      415,
      "unsupported_media_type",
      "application/json is required",
    )
    return Effect.void
  }
  return Effect.gen(function* () {
    const body = yield* readBody(request)
    const input = yield* parseJson(body)
    const spec = yield* decodeJobSpec(input)
    if (spec.kind === "harness.research") {
      yield* Effect.mapError(
        validateNewHarnessResearchPayload(spec.payload),
        () =>
          new JobRuntimeError({
            code: "invalid_input",
            message: "harness research ownership is invalid",
          }),
      )
      if (spec.runAt < Date.now() - MAX_RESEARCH_SCHEDULE_SKEW_MS)
        return yield* Effect.fail(
          new JobRuntimeError({
            code: "invalid_input",
            message: "harness research schedule is implausibly stale",
          }),
        )
    }
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
  Object.keys(value).every(key => expected.includes(key))

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
    sendError(
      response,
      415,
      "unsupported_media_type",
      "application/json is required",
    )
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
        (!Array.isArray(input.kinds) || !isRegisteredKindFilter(input.kinds)))
    ) {
      return yield* Effect.fail(
        serverError("request_failed", "worker claim payload is invalid"),
      )
    }
    yield* Effect.catchAll(
      store.recoverExpired(Date.now(), 0),
      () => Effect.void,
    )
    const job = yield* store.claimDue(
      input.workerId,
      randomUUID(),
      Date.now(),
      input.ttlMs,
      "kinds" in input &&
        Array.isArray(input.kinds) &&
        isRegisteredKindFilter(input.kinds)
        ? input.kinds
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
    sendError(
      response,
      415,
      "unsupported_media_type",
      "application/json is required",
    )
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
          serverError(
            "request_failed",
            "harness handoff does not match the live attempt",
          ),
        )
      }
      if (handoff.status === "blocked" || handoff.status === "failed") {
        return yield* Effect.fail(
          serverError(
            "request_failed",
            "unsuccessful harness handoff cannot complete a job",
          ),
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
    if (current.spec.kind === "harness.research") {
      if (
        !isRecord(input) ||
        !exactKeys(input, ["leaseToken", "handoff"]) ||
        typeof input.leaseToken !== "string"
      )
        return yield* Effect.fail(
          serverError("request_failed", "typed research handoff is required"),
        )
      const handoff = yield* Effect.mapError(
        decodeHarnessResearchHandoff(input.handoff),
        () => serverError("request_failed", "research handoff is invalid"),
      )
      if (
        !harnessResearchHandoffMatchesAttempt(
          handoff,
          current.spec.payload,
          current.id,
          current.attempt,
        )
      )
        return yield* Effect.fail(
          serverError(
            "request_failed",
            "research handoff does not match the live attempt",
          ),
        )
      const job = yield* store.complete(
        id,
        input.leaseToken,
        Date.now(),
        handoff.summary,
        { kind: "harness.research", handoff },
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
    sendError(
      response,
      415,
      "unsupported_media_type",
      "application/json is required",
    )
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
    body => {
      sendAsset(response, asset[1], body)
      return true
    },
  )
}

const handleRequest = (
  request: IncomingMessage,
  response: ServerResponse,
  store: SqliteJobStore,
  registryStore: RegistryStore | undefined,
  bridgeStore: RemoteBridgeStore | undefined,
  usageSampling: UsageSamplingStatus,
  throttleActivity: ThrottleActivity,
  dashboardDirectory?: string,
): Effect.Effect<void> => {
  const route = Effect.try({
    try: () => new URL(request.url ?? "/", "http://127.0.0.1"),
    catch: () => serverError("request_failed", "request URL is malformed"),
  })
  return Effect.catchAll(
    Effect.flatMap(route, url => {
      const { pathname: path } = url
      if (path === "/v1/health") {
        if (request.method !== "GET") {
          sendError(
            response,
            405,
            "method_not_allowed",
            "method is not allowed",
          )
          return Effect.void
        }
        sendJson(response, 200, {
          status: "ok",
          protocolVersion: CONTROL_PLANE_PROTOCOL_VERSION,
          schemaVersion: CONTROL_PLANE_SCHEMA_VERSION,
        })
        return Effect.void
      }
      if (path === "/v1/agents")
        return handleAgents(request, response, registryStore, bridgeStore)
      if (path === "/v1/usage")
        return handleUsage(
          request,
          response,
          store,
          usageSampling,
          throttleActivity,
        )
      if (path === "/v1/usage/control")
        return handleUsageControl(
          request,
          response,
          store,
          url,
          throttleActivity,
        )
      if (path === "/v1/usage/status") {
        if (request.method !== "GET") {
          sendError(
            response,
            405,
            "method_not_allowed",
            "method is not allowed",
          )
          return Effect.void
        }
        sendJson(response, 200, { sampling: usageSampling })
        return Effect.void
      }
      if (path === "/v1/usage/admit")
        return handleUsageAdmission(
          request,
          response,
          store,
          url,
          throttleActivity,
        )
      if (path === "/v1/usage/interventions")
        return handleOwnerIntervention(request, response, store)
      if (path === "/v1/usage/provider-calls/reserve")
        return handleProviderCallReservation(
          request,
          response,
          store,
          throttleActivity,
        )
      if (path === "/v1/usage/provider-calls/settle")
        return handleProviderCallSettlement(
          request,
          response,
          store,
          throttleActivity,
        )
      if (path === "/v1/jobs") return handleJobs(request, response, store)
      if (path === "/v1/worker/claim")
        return handleClaim(request, response, store)
      const completeMatch =
        /^\/v1\/jobs\/([A-Za-z0-9][A-Za-z0-9:._-]{0,127})\/complete$/u.exec(
          path,
        )
      if (completeMatch?.[1])
        return handleComplete(completeMatch[1], request, response, store)
      const failMatch =
        /^\/v1\/jobs\/([A-Za-z0-9][A-Za-z0-9:._-]{0,127})\/fail$/u.exec(path)
      if (failMatch?.[1])
        return handleFail(failMatch[1], request, response, store)
      if (dashboardDirectory) {
        return Effect.flatMap(
          handleDashboard(path, request, response, dashboardDirectory),
          handled => {
            if (!handled)
              sendError(response, 404, "not_found", "route was not found")
            return Effect.void
          },
        )
      }
      sendError(response, 404, "not_found", "route was not found")
      return Effect.void
    }),
    error => internalFailure(response, error),
  )
}

export const startControlPlaneServer = (
  options: ControlPlaneServerOptions,
): Effect.Effect<RunningControlPlaneServer, ControlPlaneServerError> => {
  if (
    options.host !== LOOPBACK_HOSTS[0] &&
    options.host !== LOOPBACK_HOSTS[1]
  ) {
    return Effect.fail(
      serverError(
        "invalid_bind",
        "control plane must bind to a loopback address",
      ),
    )
  }
  if (
    !Number.isSafeInteger(options.port) ||
    options.port < 0 ||
    options.port > 65_535
  ) {
    return Effect.fail(
      serverError(
        "invalid_bind",
        "control plane port must be between 0 and 65535",
      ),
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

  return Effect.async(resume => {
    const throttleActivity = new ThrottleActivity()
    const usageSampling: UsageSamplingStatus = {
      status: options.registryStore ? "sampling" : "unavailable",
      allowance: {
        status: options.codexExecutable ? "sampling" : "unavailable",
      },
    }
    let sampling = false
    let allowanceSampling = false
    const captureUsage = async (): Promise<void> => {
      if (!options.registryStore || sampling) return
      sampling = true
      const now = Date.now()
      usageSampling.status = "sampling"
      usageSampling.lastAttemptAt = now
      delete usageSampling.error
      try {
        const snapshot = await Effect.runPromise(
          Effect.either(options.registryStore.snapshot(now)),
        )
        if (Either.isLeft(snapshot)) {
          usageSampling.status = "error"
          usageSampling.error = "registry"
          return
        }
        const persisted = await Effect.runPromise(
          Effect.either(
            options.store.recordUsage(snapshot.right.agents ?? [], now),
          ),
        )
        if (Either.isLeft(persisted)) {
          usageSampling.status = "error"
          usageSampling.error = "store"
          return
        }
        usageSampling.status = "ok"
        usageSampling.lastCapturedAt = now
      } catch {
        usageSampling.status = "error"
        usageSampling.error = "store"
      } finally {
        sampling = false
      }
    }
    const captureCodexAllowance = async (): Promise<void> => {
      if (!options.codexExecutable || allowanceSampling) return
      allowanceSampling = true
      const now = Date.now()
      usageSampling.allowance.status = "sampling"
      usageSampling.allowance.lastAttemptAt = now
      delete usageSampling.allowance.error
      try {
        const sampled = await Effect.runPromise(
          Effect.either(
            sampleCodexWeeklyAllowance(options.codexExecutable, now),
          ),
        )
        if (Either.isLeft(sampled)) {
          usageSampling.allowance.status = "error"
          usageSampling.allowance.error = "provider"
          return
        }
        const persisted = await Effect.runPromise(
          Effect.either(options.store.recordAllowanceCheckpoint(sampled.right)),
        )
        if (Either.isLeft(persisted)) {
          usageSampling.allowance.status = "error"
          usageSampling.allowance.error = "store"
          return
        }
        usageSampling.allowance.status = "ok"
        usageSampling.allowance.lastCapturedAt = now
      } catch {
        usageSampling.allowance.status = "error"
        usageSampling.allowance.error = "provider"
      } finally {
        allowanceSampling = false
      }
    }
    void captureUsage()
    void captureCodexAllowance()
    const usageTimer = setInterval(
      () => void captureUsage(),
      USAGE_SAMPLE_INTERVAL_MS,
    )
    const allowanceTimer = setInterval(
      () => void captureCodexAllowance(),
      CODEX_ALLOWANCE_SAMPLE_INTERVAL_MS,
    )
    usageTimer.unref?.()
    allowanceTimer.unref?.()

    const server = createServer((request, response) => {
      void Effect.runPromise(
        handleRequest(
          request,
          response,
          options.store,
          options.registryStore,
          options.bridgeStore,
          usageSampling,
          throttleActivity,
          options.dashboardDirectory,
        ),
      )
    })
    let settled = false
    server.once("error", () => {
      if (settled) return
      settled = true
      clearInterval(usageTimer)
      clearInterval(allowanceTimer)
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
          close: Effect.async<void, ControlPlaneServerError>(closeResume => {
            clearInterval(usageTimer)
            clearInterval(allowanceTimer)
            server.close(closeError =>
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
