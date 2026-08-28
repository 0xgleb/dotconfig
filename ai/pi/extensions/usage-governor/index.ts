import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent"
import { randomUUID } from "node:crypto"
import { Data, Effect, Either } from "effect"
import { Type } from "typebox"
import { registerRuntimeVersion } from "../shared/runtime-version.ts"
import {
  HUMAN_TURN_EVENT,
  OWNER_INTERVENTION_QUERY_EVENT,
  OWNER_INTERVENTION_RELAY_EVENT,
  RESPONSIVE_AUTONOMOUS_TURN_EVENT,
  type OwnerInterventionQuery,
  type OwnerInterventionRelay,
} from "../shared/usage-governor-events.ts"
import {
  autonomousRoleForCwd,
  controlPlaneUsageAdmissionUrl,
  controlPlaneUsageControlUrl,
  controlPlaneUsageUrl,
  emptyTurnLaneState,
  manualAllowanceCheckpointRequest,
  MAX_ALLOWANCE_PERCENT,
  markHumanFollowUp,
  markResponsiveAutonomousTurn,
  parseAllowanceCheckpointInput,
  parseAutonomousAdmission,
  parsePersistedModelRef,
  preferredModelRestoration,
  recordInputLane,
  takeTurnLane,
  type AllowanceCheckpointInput,
  type AutonomousAdmissionDecision,
  type ManagedThinkingLevel,
  type ManualAllowancePool,
  type PersistedModelRef,
  type TurnLane,
} from "./core.ts"
import {
  providerCallAction,
  providerCallReservationPayload,
  providerCallSettlement,
  type PendingProviderCall,
} from "./provider-call-state.ts"
import {
  decodeThrottleControl,
  ThrottleHudComponent,
  throttleStatusText,
  type ThrottleControl,
} from "./throttle-hud.ts"

const STATE_ENTRY = "usage-governor.preferred-model"
const ADMISSION_TIMEOUT_MS = 2_000
const ADMISSION_RETRY_MS = 1_000
const MAX_ADMISSION_DELAY_MS = 60_000
const THROTTLE_REFRESH_MS = 60_000
const throttlingMode = (): "disabled" | "enabled" => "disabled"

class UsageControlError extends Data.TaggedError("UsageControlError")<{
  readonly code: "invalid_config" | "request_failed" | "invalid_response"
}> {}

const requestThrottleControl = (
  agentId: string,
  cwd: string,
): Effect.Effect<ThrottleControl, UsageControlError> => {
  const controlUrl = controlPlaneUsageControlUrl(
    process.env.PI_CONTROL_PLANE_PORT,
  )
  if (!controlUrl)
    return Effect.fail(new UsageControlError({ code: "invalid_config" }))
  const url = new URL(controlUrl)
  url.searchParams.set("agentId", agentId)
  url.searchParams.set("cwd", cwd)
  return Effect.flatMap(
    Effect.tryPromise({
      try: signal => fetch(url, { signal }),
      catch: () => new UsageControlError({ code: "request_failed" }),
    }).pipe(Effect.timeout(ADMISSION_TIMEOUT_MS)),
    response =>
      response.ok
        ? Effect.flatMap(
            Effect.tryPromise({
              try: () => response.json() as Promise<unknown>,
              catch: () => new UsageControlError({ code: "invalid_response" }),
            }),
            value => {
              const control = decodeThrottleControl(value)
              return control
                ? Effect.succeed(control)
                : Effect.fail(
                    new UsageControlError({ code: "invalid_response" }),
                  )
            },
          )
        : Effect.fail(new UsageControlError({ code: "request_failed" })),
  ).pipe(
    Effect.mapError(error =>
      error instanceof UsageControlError
        ? error
        : new UsageControlError({ code: "request_failed" }),
    ),
  )
}

const requestAutonomousAdmission = (
  role: string,
  request: {
    readonly kind?: "turn" | "workflow"
    readonly requestedTokens?: number
  } = {},
): Effect.Effect<AutonomousAdmissionDecision, UsageControlError> => {
  const url = controlPlaneUsageAdmissionUrl(
    process.env.PI_CONTROL_PLANE_PORT,
    role,
    request,
  )
  if (!url)
    return Effect.fail(new UsageControlError({ code: "invalid_config" }))
  return Effect.flatMap(
    Effect.tryPromise({
      try: signal => fetch(url, { method: "POST", signal }),
      catch: () => new UsageControlError({ code: "request_failed" }),
    }).pipe(Effect.timeout(ADMISSION_TIMEOUT_MS)),
    response =>
      response.ok
        ? Effect.flatMap(
            Effect.tryPromise({
              try: () => response.json() as Promise<unknown>,
              catch: () => new UsageControlError({ code: "invalid_response" }),
            }),
            value => {
              const admission = parseAutonomousAdmission(value)
              return admission
                ? Effect.succeed(admission)
                : Effect.fail(
                    new UsageControlError({ code: "invalid_response" }),
                  )
            },
          )
        : Effect.fail(new UsageControlError({ code: "request_failed" })),
  ).pipe(
    Effect.mapError(error =>
      error instanceof UsageControlError
        ? error
        : new UsageControlError({ code: "request_failed" }),
    ),
  )
}

const isRefillCheckpoint = (
  checkpoint: AllowanceCheckpointInput,
): checkpoint is Extract<
  AllowanceCheckpointInput,
  { readonly event: "refill" }
> => "event" in checkpoint && checkpoint.event === "refill"

const recordAllowanceCheckpoint = (
  checkpoint: AllowanceCheckpointInput,
  pool: ManualAllowancePool = "chatgpt-shared-weekly",
): Effect.Effect<void, UsageControlError> => {
  const url = controlPlaneUsageUrl(process.env.PI_CONTROL_PLANE_PORT)
  if (!url)
    return Effect.fail(new UsageControlError({ code: "invalid_config" }))
  return Effect.flatMap(
    Effect.tryPromise({
      try: signal =>
        fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(
            manualAllowanceCheckpointRequest(checkpoint, pool),
          ),
          signal,
        }),
      catch: () => new UsageControlError({ code: "request_failed" }),
    }).pipe(Effect.timeout(ADMISSION_TIMEOUT_MS)),
    response =>
      response.ok
        ? Effect.void
        : Effect.fail(new UsageControlError({ code: "request_failed" })),
  ).pipe(
    Effect.mapError(error =>
      error instanceof UsageControlError
        ? error
        : new UsageControlError({ code: "request_failed" }),
    ),
  )
}

type ProviderCallReservationDecision =
  | {
      readonly allowed: true
      readonly reservationId: string
    }
  | {
      readonly allowed: false
      readonly retryAt: number
    }

const parseProviderCallReservationDecision = (
  value: unknown,
  reservationId: string,
): ProviderCallReservationDecision | undefined => {
  if (
    typeof value !== "object" ||
    value === null ||
    !("reservation" in value) ||
    typeof value.reservation !== "object" ||
    value.reservation === null ||
    !("allowed" in value.reservation)
  )
    return undefined
  const reservation = value.reservation
  if (
    reservation.allowed === true &&
    "reservationId" in reservation &&
    reservation.reservationId === reservationId
  )
    return { allowed: true, reservationId }
  if (
    reservation.allowed === false &&
    "retryAt" in reservation &&
    typeof reservation.retryAt === "number" &&
    Number.isSafeInteger(reservation.retryAt)
  )
    return { allowed: false, retryAt: reservation.retryAt }
  return undefined
}

const providerCallUrl = (
  portValue: string | undefined,
  action: "reserve" | "settle",
): string | undefined => {
  const usageUrl = controlPlaneUsageUrl(portValue)
  return usageUrl ? `${usageUrl}/provider-calls/${action}` : undefined
}

const recordRelayedOwnerIntervention = (
  intervention: OwnerInterventionRelay,
): Effect.Effect<void, UsageControlError> => {
  const usageUrl = controlPlaneUsageUrl(process.env.PI_CONTROL_PLANE_PORT)
  if (!usageUrl)
    return Effect.fail(new UsageControlError({ code: "invalid_config" }))
  return Effect.flatMap(
    Effect.tryPromise({
      try: signal =>
        fetch(`${usageUrl}/interventions`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(intervention),
          signal,
        }),
      catch: () => new UsageControlError({ code: "request_failed" }),
    }).pipe(Effect.timeout(ADMISSION_TIMEOUT_MS)),
    response =>
      response.ok
        ? Effect.void
        : Effect.fail(new UsageControlError({ code: "request_failed" })),
  ).pipe(
    Effect.mapError(error =>
      error instanceof UsageControlError
        ? error
        : new UsageControlError({ code: "request_failed" }),
    ),
  )
}

const requestProviderCallReservation = (
  reservationId: string,
  agentId: string,
  cwd: string,
  role: string,
  requestedTokens: number,
  lane: TurnLane,
  ownerInteractionAt: number | undefined,
): Effect.Effect<ProviderCallReservationDecision, UsageControlError> => {
  const url = providerCallUrl(process.env.PI_CONTROL_PLANE_PORT, "reserve")
  if (!url)
    return Effect.fail(new UsageControlError({ code: "invalid_config" }))
  return Effect.flatMap(
    Effect.tryPromise({
      try: signal =>
        fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(
            providerCallReservationPayload({
              reservationId,
              agentId,
              cwd,
              role,
              requestedTokens,
              lane,
              ownerInteractionAt,
            }),
          ),
          signal,
        }),
      catch: () => new UsageControlError({ code: "request_failed" }),
    }).pipe(Effect.timeout(ADMISSION_TIMEOUT_MS)),
    response =>
      response.ok
        ? Effect.flatMap(
            Effect.tryPromise({
              try: () => response.json() as Promise<unknown>,
              catch: () => new UsageControlError({ code: "invalid_response" }),
            }),
            value => {
              const reservation = parseProviderCallReservationDecision(
                value,
                reservationId,
              )
              return reservation
                ? Effect.succeed(reservation)
                : Effect.fail(
                    new UsageControlError({ code: "invalid_response" }),
                  )
            },
          )
        : Effect.fail(new UsageControlError({ code: "request_failed" })),
  ).pipe(
    Effect.mapError(error =>
      error instanceof UsageControlError
        ? error
        : new UsageControlError({ code: "request_failed" }),
    ),
  )
}

const settleProviderCallReservation = (
  reservationId: string,
  actualTokens: number,
): Effect.Effect<void, UsageControlError> => {
  const url = providerCallUrl(process.env.PI_CONTROL_PLANE_PORT, "settle")
  if (!url)
    return Effect.fail(new UsageControlError({ code: "invalid_config" }))
  return Effect.flatMap(
    Effect.tryPromise({
      try: signal =>
        fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ reservationId, actualTokens }),
          signal,
        }),
      catch: () => new UsageControlError({ code: "request_failed" }),
    }).pipe(Effect.timeout(ADMISSION_TIMEOUT_MS)),
    response =>
      response.ok
        ? Effect.void
        : Effect.fail(new UsageControlError({ code: "request_failed" })),
  ).pipe(
    Effect.mapError(error =>
      error instanceof UsageControlError
        ? error
        : new UsageControlError({ code: "request_failed" }),
    ),
  )
}

const requestedProviderTokens = (ctx: ExtensionContext): number => {
  const contextTokens = ctx.getContextUsage()?.tokens ?? 0
  const outputTokens = ctx.model?.maxTokens ?? 0
  return Math.max(
    1,
    Math.min(2_000_000, Math.ceil(contextTokens + outputTokens)),
  )
}

const waitForAdmission = (retryAt = Date.now() + ADMISSION_RETRY_MS) =>
  new Promise<void>(resolve =>
    setTimeout(
      resolve,
      Math.max(
        ADMISSION_RETRY_MS,
        Math.min(MAX_ADMISSION_DELAY_MS, retryAt - Date.now()),
      ),
    ),
  )

const restoredModel = (
  ctx: ExtensionContext,
): PersistedModelRef | undefined => {
  for (const entry of ctx.sessionManager.getBranch().toReversed()) {
    if (entry.type !== "custom" || entry.customType !== STATE_ENTRY) continue
    return parsePersistedModelRef(entry.data)
  }
  return undefined
}

export default function usageGovernor(pi: ExtensionAPI): void {
  registerRuntimeVersion(pi, "usage-governor", "2026.08.20.1")
  let turnLaneState = emptyTurnLaneState()
  let preferredModel: PersistedModelRef | undefined
  let managedSwitch = false
  let activeTurnLane: TurnLane = "autonomous"
  let activeOwnerInteractionAt: number | undefined
  let latestOwnerInputAt: number | undefined
  let activeReservation: PendingProviderCall | undefined
  let throttleControl: ThrottleControl | undefined
  let throttleExpanded = false
  let throttleTimer: ReturnType<typeof setInterval> | undefined
  let throttleLifecycleEpoch = 0
  let requestThrottleRender: (() => void) | undefined

  const refreshThrottle = async (
    ctx: ExtensionContext,
    lifecycleEpoch = throttleLifecycleEpoch,
  ): Promise<void> => {
    const result = await Effect.runPromise(
      Effect.either(
        requestThrottleControl(ctx.sessionManager.getSessionId(), ctx.cwd),
      ),
    )
    if (lifecycleEpoch !== throttleLifecycleEpoch) return
    if (Either.isLeft(result)) {
      ctx.ui.setStatus("usage-throttle", "throttle:unavailable")
      return
    }
    throttleControl = result.right
    ctx.ui.setStatus(
      "usage-throttle",
      ctx.mode === "tui" ? undefined : throttleStatusText(throttleControl),
    )
    requestThrottleRender?.()
  }

  const rememberModel = (
    model: Omit<PersistedModelRef, "thinking">,
    thinking: ManagedThinkingLevel = pi.getThinkingLevel(),
  ): void => {
    const selected = { ...model, thinking }
    if (
      preferredModel?.provider === selected.provider &&
      preferredModel.id === selected.id &&
      preferredModel.thinking === selected.thinking
    )
      return
    preferredModel = selected
    pi.appendEntry(STATE_ENTRY, selected)
  }

  const switchModel = async (
    model: NonNullable<ExtensionContext["model"]>,
    thinking: ManagedThinkingLevel,
  ): Promise<boolean> => {
    managedSwitch = true
    try {
      const switched = await pi.setModel(model)
      if (switched) pi.setThinkingLevel(thinking)
      return switched
    } finally {
      managedSwitch = false
    }
  }

  const restorePreferredModel = async (
    ctx: ExtensionContext,
  ): Promise<boolean> => {
    const preferred = preferredModel
      ? ctx.modelRegistry.find(preferredModel.provider, preferredModel.id)
      : undefined
    const restoration = preferredModelRestoration(
      ctx.model
        ? {
            provider: ctx.model.provider,
            id: ctx.model.id,
            thinking: ctx.thinkingLevel,
          }
        : undefined,
      preferredModel,
      preferred !== undefined,
    )
    if (restoration.action === "ready") return true
    if (restoration.action === "set-thinking") {
      pi.setThinkingLevel(restoration.thinking)
      return true
    }
    if (restoration.action === "use-active-model") {
      if (ctx.model)
        rememberModel(
          { provider: ctx.model.provider, id: ctx.model.id },
          ctx.thinkingLevel,
        )
      return true
    }
    if (
      restoration.action === "switch-model" &&
      preferred &&
      preferredModel &&
      (await switchModel(preferred, preferredModel.thinking ?? "high"))
    )
      return true
    if (ctx.model) {
      rememberModel(
        { provider: ctx.model.provider, id: ctx.model.id },
        ctx.thinkingLevel,
      )
      return true
    }
    ctx.ui.setStatus(
      "usage-governor",
      "usage:model unavailable · provider call queued",
    )
    return false
  }

  const awaitPreferredModel = async (ctx: ExtensionContext): Promise<void> => {
    while (!(await restorePreferredModel(ctx))) await waitForAdmission()
  }

  const awaitProviderCallReservation = async (
    ctx: ExtensionContext,
  ): Promise<void> => {
    const provider = ctx.model?.provider ?? ""
    let action = providerCallAction(activeReservation, activeTurnLane, provider)
    if (action.action === "skip") return

    while (action.action !== "reserve") {
      if (action.action === "block-unresolved") {
        ctx.ui.setStatus("usage-governor", "usage:provider settlement pending")
        await waitForAdmission()
      } else if (action.action === "retry-settlement") {
        const settlement = await Effect.runPromise(
          Effect.either(
            settleProviderCallReservation(
              action.reservationId,
              action.actualTokens,
            ),
          ),
        )
        if (Either.isRight(settlement)) {
          activeReservation = undefined
          void refreshThrottle(ctx)
        } else {
          ctx.ui.setStatus(
            "usage-governor",
            "usage:settlement unavailable · provider call queued",
          )
          await waitForAdmission()
        }
      } else {
        return
      }
      action = providerCallAction(activeReservation, activeTurnLane, provider)
    }

    const reservationId = randomUUID()
    while (true) {
      const reservation = await Effect.runPromise(
        Effect.either(
          requestProviderCallReservation(
            reservationId,
            ctx.sessionManager.getSessionId(),
            ctx.cwd,
            autonomousRoleForCwd(ctx.cwd, process.env.HOME),
            requestedProviderTokens(ctx),
            activeTurnLane,
            activeOwnerInteractionAt,
          ),
        ),
      )
      if (Either.isLeft(reservation)) {
        ctx.ui.setStatus(
          "usage-governor",
          "usage:provider budget unavailable · call queued",
        )
        void refreshThrottle(ctx)
        await waitForAdmission()
        continue
      }
      if (!reservation.right.allowed) {
        ctx.ui.setStatus(
          "usage-governor",
          `usage:provider queued · retry ${new Date(reservation.right.retryAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`,
        )
        void refreshThrottle(ctx)
        await waitForAdmission(reservation.right.retryAt)
        continue
      }
      activeReservation = { reservationId }
      void refreshThrottle(ctx)
      return
    }
  }

  const awaitWorkflowAdmission = async (
    ctx: ExtensionContext,
    requestedTokens: number,
  ): Promise<
    Extract<AutonomousAdmissionDecision, { readonly allowed: true }>
  > => {
    while (true) {
      const result = await Effect.runPromise(
        Effect.either(
          requestAutonomousAdmission(
            autonomousRoleForCwd(ctx.cwd, process.env.HOME),
            { kind: "workflow", requestedTokens },
          ),
        ),
      )
      if (Either.isLeft(result)) {
        ctx.ui.setStatus(
          "usage-governor",
          "usage:workflow grant unavailable · workflow queued",
        )
        await waitForAdmission()
        continue
      }
      if (!result.right.allowed) {
        ctx.ui.setStatus(
          "usage-governor",
          `usage:workflow queued · retry ${new Date(result.right.retryAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`,
        )
        void refreshThrottle(ctx)
        await waitForAdmission(result.right.retryAt)
        continue
      }
      return result.right
    }
  }

  pi.registerTool({
    name: "usage_checkpoint",
    label: "Usage checkpoint",
    description:
      "Record an owner-verified OpenAI weekly allowance checkpoint for the selected ChatGPT or Codex pool. Omit resetAt only when the provider UI explicitly shows no reset; that records a refill event without inventing one.",
    promptSnippet:
      "Record an owner-verified ChatGPT or Codex weekly allowance checkpoint or reset-unknown refill",
    promptGuidelines: [
      "Use usage_checkpoint only for allowance values and timestamps explicitly verified by the owner or provider UI; never infer missing checkpoint fields or reuse a stale reset after a refill.",
      "Select codex-app-server-weekly when the owner is correcting the Codex allowance shown by Pi; omitted pool values preserve the existing ChatGPT shared-weekly behavior.",
    ],
    parameters: Type.Object({
      remainingPercent: Type.Number({
        minimum: 0,
        maximum: MAX_ALLOWANCE_PERCENT,
      }),
      pool: Type.Optional(
        Type.Union([
          Type.Literal("chatgpt-shared-weekly"),
          Type.Literal("codex-app-server-weekly"),
        ]),
      ),
      resetAt: Type.Optional(Type.String({ maxLength: 80 })),
      capturedAt: Type.String({ maxLength: 80 }),
    }),
    async execute(_toolCallId, request) {
      const checkpoint = parseAllowanceCheckpointInput(
        `${request.remainingPercent} ${request.resetAt ?? "refill"} ${request.capturedAt}`,
      )
      if (!checkpoint) throw new Error("usage checkpoint input is invalid")
      const result = await Effect.runPromise(
        Effect.either(recordAllowanceCheckpoint(checkpoint, request.pool)),
      )
      if (Either.isLeft(result))
        throw new Error("control plane rejected the usage checkpoint")
      return {
        content: [
          {
            type: "text" as const,
            text: isRefillCheckpoint(checkpoint)
              ? `Recorded ${checkpoint.remainingPercent}% remaining at ${new Date(checkpoint.capturedAt).toISOString()} as a reset-unknown refill.`
              : `Recorded ${checkpoint.remainingPercent}% remaining at ${new Date(checkpoint.capturedAt).toISOString()}; resets ${new Date(checkpoint.resetAt).toISOString()}.`,
          },
        ],
        details: {
          checkpoint: manualAllowanceCheckpointRequest(
            checkpoint,
            request.pool,
          ),
        },
      }
    },
  })

  pi.registerCommand("usage-checkpoint", {
    description:
      "Record subscription allowance: <remaining%> <reset ISO-8601|refill> [captured ISO-8601]",
    handler: async (args, ctx) => {
      const checkpoint = parseAllowanceCheckpointInput(args)
      if (!checkpoint) {
        ctx.ui.notify(
          "Usage: /usage-checkpoint <remaining%> <reset ISO-8601|refill> [captured ISO-8601]",
          "warning",
        )
        return
      }
      const result = await Effect.runPromise(
        Effect.either(recordAllowanceCheckpoint(checkpoint)),
      )
      if (Either.isLeft(result)) {
        ctx.ui.notify("Could not record the allowance checkpoint", "error")
        return
      }
      ctx.ui.notify(
        isRefillCheckpoint(checkpoint)
          ? `Recorded ${checkpoint.remainingPercent}% remaining as a reset-unknown refill`
          : `Recorded ${checkpoint.remainingPercent}% remaining; resets ${new Date(checkpoint.resetAt).toLocaleString()}`,
        "info",
      )
    },
  })

  pi.registerCommand("throttle", {
    description: "Toggle detailed fleet-throttle HUD and refresh its state",
    handler: async (_args, ctx) => {
      if (throttlingMode() === "disabled") {
        ctx.ui.notify("Throttling is disabled", "info")
        return
      }
      throttleExpanded = !throttleExpanded
      await refreshThrottle(ctx)
      requestThrottleRender?.()
      ctx.ui.notify(
        throttleControl
          ? `${throttleExpanded ? "Expanded" : "Compact"} throttle HUD · ${throttleStatusText(throttleControl)}`
          : "Throttle control is unavailable",
        throttleControl ? "info" : "warning",
      )
    },
  })

  pi.events.on(HUMAN_TURN_EVENT, (prompt: unknown) => {
    const now = Date.now()
    latestOwnerInputAt = now
    activeOwnerInteractionAt = now
    turnLaneState = markHumanFollowUp(turnLaneState, prompt, now)
  })

  pi.events.on(
    OWNER_INTERVENTION_QUERY_EVENT,
    (query: OwnerInterventionQuery) => {
      query.report(
        activeTurnLane === "human" ? activeOwnerInteractionAt : undefined,
      )
    },
  )

  pi.events.on(
    OWNER_INTERVENTION_RELAY_EVENT,
    (intervention: OwnerInterventionRelay) => {
      void Effect.runPromise(
        Effect.ignore(recordRelayedOwnerIntervention(intervention)),
      )
    },
  )

  pi.events.on(RESPONSIVE_AUTONOMOUS_TURN_EVENT, (prompt: unknown) => {
    turnLaneState = markResponsiveAutonomousTurn(turnLaneState, prompt)
  })

  pi.on("session_start", (_event, ctx) => {
    throttleLifecycleEpoch += 1
    preferredModel = restoredModel(ctx)
    if (!preferredModel && ctx.model)
      rememberModel(
        { provider: ctx.model.provider, id: ctx.model.id },
        ctx.thinkingLevel,
      )

    if (throttleTimer) clearInterval(throttleTimer)
    throttleControl = undefined
    throttleExpanded = false
    requestThrottleRender = undefined
    if (throttlingMode() === "disabled") {
      ctx.ui.setStatus("usage-throttle", undefined)
      ctx.ui.setWidget("usage-throttle", undefined)
      return
    }
    ctx.ui.setStatus(
      "usage-throttle",
      ctx.mode === "tui" ? undefined : "throttle:loading",
    )
    if (ctx.mode === "tui")
      ctx.ui.setWidget(
        "usage-throttle",
        (tui, theme) => {
          requestThrottleRender = () => tui.requestRender()
          return new ThrottleHudComponent(
            () => throttleControl,
            () => throttleExpanded,
            theme,
          )
        },
        { placement: "aboveEditor" },
      )
    void refreshThrottle(ctx)
    throttleTimer = setInterval(
      () => void refreshThrottle(ctx),
      THROTTLE_REFRESH_MS,
    )
  })

  pi.on("session_shutdown", (_event, ctx) => {
    throttleLifecycleEpoch += 1
    if (throttleTimer) clearInterval(throttleTimer)
    throttleTimer = undefined
    throttleControl = undefined
    requestThrottleRender = undefined
    ctx.ui.setStatus("usage-throttle", undefined)
  })

  pi.on("model_select", event => {
    if (managedSwitch) return
    rememberModel({ provider: event.model.provider, id: event.model.id })
  })

  pi.on("thinking_level_select", event => {
    if (managedSwitch || !preferredModel) return
    rememberModel(preferredModel, event.level)
  })

  pi.on("input", event => {
    if (event.source !== "extension") {
      const now = Date.now()
      latestOwnerInputAt = now
      activeOwnerInteractionAt = now
    }
    turnLaneState = recordInputLane(turnLaneState, event)
  })

  pi.on("before_provider_request", async (event, ctx) => {
    await awaitPreferredModel(ctx)
    if (throttlingMode() === "enabled") await awaitProviderCallReservation(ctx)
    return event.payload
  })

  pi.on("message_end", async (event, ctx) => {
    if (!activeReservation || event.message.role !== "assistant") return
    const pendingSettlement = providerCallSettlement(activeReservation, {
      provider: event.message.provider,
      totalTokens: event.message.usage.totalTokens,
    })
    if (!pendingSettlement) {
      ctx.ui.setStatus(
        "usage-governor",
        "usage:provider usage malformed · next provider call queued",
      )
      return
    }
    activeReservation = pendingSettlement
    const settlement = await Effect.runPromise(
      Effect.either(
        settleProviderCallReservation(
          pendingSettlement.reservationId,
          pendingSettlement.actualTokens,
        ),
      ),
    )
    if (Either.isLeft(settlement)) {
      ctx.ui.setStatus(
        "usage-governor",
        "usage:settlement unavailable · next provider call queued",
      )
      return
    }
    activeReservation = undefined
    void refreshThrottle(ctx)
  })

  pi.on("tool_call", async (event, ctx) => {
    if (throttlingMode() === "disabled" || event.toolName !== "workflow") return
    const requestedTokens = event.input.tokenBudget
    if (
      typeof requestedTokens !== "number" ||
      !Number.isSafeInteger(requestedTokens)
    )
      return {
        block: true,
        reason: "Workflow token budget is malformed",
      }
    const admission = await awaitWorkflowAdmission(ctx, requestedTokens)
    void refreshThrottle(ctx)
    if (
      admission.grantedTokens !== undefined &&
      admission.grantedTokens < requestedTokens
    )
      event.input.tokenBudget = admission.grantedTokens
  })

  pi.on("before_agent_start", async (event, ctx) => {
    const turn = takeTurnLane(turnLaneState, event.prompt)
    turnLaneState = turn.state
    activeTurnLane = turn.lane
    activeOwnerInteractionAt =
      turn.lane === "human" ? (latestOwnerInputAt ?? Date.now()) : undefined

    await awaitPreferredModel(ctx)
    ctx.ui.setStatus("usage-governor", "usage:unthrottled")
  })
}
