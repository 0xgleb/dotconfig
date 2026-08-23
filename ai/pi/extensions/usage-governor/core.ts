import {
  isAllowanceRemainingPercent,
  MAX_ALLOWANCE_PERCENT,
} from "../control-plane/usage-policy.ts"

export { MAX_ALLOWANCE_PERCENT }

export type TurnLane = "human" | "responsive" | "autonomous"

const MAX_PENDING_TURNS = 64
const HUMAN_FOLLOW_UP_TTL_MS = 5_000

export interface TurnLaneState {
  readonly pendingHumanFollowUps: readonly {
    readonly prompt: string
    readonly expiresAt: number
  }[]
  readonly pendingTurns: readonly {
    readonly prompt: string
    readonly lane: TurnLane
  }[]
}

export const emptyTurnLaneState = (): TurnLaneState => ({
  pendingHumanFollowUps: [],
  pendingTurns: [],
})

export const turnLaneForInput = (
  source: "interactive" | "rpc" | "extension",
): TurnLane => (source === "extension" ? "autonomous" : "human")

export const markHumanFollowUp = (
  state: TurnLaneState,
  prompt: unknown,
  now = Date.now(),
): TurnLaneState =>
  typeof prompt === "string" &&
  prompt.length >= 1 &&
  prompt.length <= 100_000 &&
  Number.isSafeInteger(now) &&
  now >= 0 &&
  Number.isSafeInteger(now + HUMAN_FOLLOW_UP_TTL_MS)
    ? {
        ...state,
        pendingHumanFollowUps: [
          ...state.pendingHumanFollowUps,
          { prompt, expiresAt: now + HUMAN_FOLLOW_UP_TTL_MS },
        ].slice(-MAX_PENDING_TURNS),
      }
    : state

export const markResponsiveAutonomousTurn = (
  state: TurnLaneState,
  prompt: unknown,
): TurnLaneState =>
  typeof prompt === "string" && prompt.length >= 1 && prompt.length <= 100_000
    ? {
        ...state,
        pendingTurns: [
          ...state.pendingTurns,
          { prompt, lane: "responsive" as const },
        ].slice(-MAX_PENDING_TURNS),
      }
    : state

export const recordInputLane = (
  state: TurnLaneState,
  input: {
    readonly source: "interactive" | "rpc" | "extension"
    readonly text: string
  },
  now = Date.now(),
): TurnLaneState => {
  const activeFollowUps = state.pendingHumanFollowUps.filter(
    ({ expiresAt }) => expiresAt >= now,
  )
  const followUpIndex =
    input.source === "extension"
      ? activeFollowUps.findIndex(({ prompt }) => prompt === input.text)
      : -1
  const lane = followUpIndex >= 0 ? "human" : turnLaneForInput(input.source)
  return {
    pendingHumanFollowUps:
      followUpIndex >= 0
        ? activeFollowUps.filter((_prompt, index) => index !== followUpIndex)
        : activeFollowUps,
    pendingTurns: [...state.pendingTurns, { prompt: input.text, lane }].slice(
      -MAX_PENDING_TURNS,
    ),
  }
}

export const takeTurnLane = (
  state: TurnLaneState,
  prompt: string,
): { readonly state: TurnLaneState; readonly lane: TurnLane } => {
  const turnIndex = state.pendingTurns.findIndex(
    pending => pending.prompt === prompt,
  )
  if (turnIndex < 0) return { state, lane: "autonomous" }
  return {
    state: {
      ...state,
      pendingTurns: state.pendingTurns.filter(
        (_turn, index) => index !== turnIndex,
      ),
    },
    lane: state.pendingTurns[turnIndex]?.lane ?? "autonomous",
  }
}

export type ManagedThinkingLevel =
  | "off"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max"

export interface PersistedModelRef {
  readonly provider: string
  readonly id: string
  readonly thinking?: ManagedThinkingLevel
}

export interface ActiveModelRef {
  readonly provider: string
  readonly id: string
  readonly thinking: ManagedThinkingLevel | undefined
}

export type PreferredModelRestoration =
  | { readonly action: "ready" }
  | {
      readonly action: "set-thinking"
      readonly thinking: ManagedThinkingLevel
    }
  | { readonly action: "switch-model" }
  | { readonly action: "use-active-model" }
  | { readonly action: "wait-for-model" }

export const preferredModelRestoration = (
  active: ActiveModelRef | undefined,
  preferred: PersistedModelRef | undefined,
  preferredAvailable: boolean,
): PreferredModelRestoration => {
  if (!preferred) return { action: "ready" }
  const thinking = preferred.thinking ?? "high"
  if (active?.provider === preferred.provider && active.id === preferred.id)
    return active.thinking === thinking
      ? { action: "ready" }
      : { action: "set-thinking", thinking }
  if (preferredAvailable) return { action: "switch-model" }
  return active ? { action: "use-active-model" } : { action: "wait-for-model" }
}

export type UsagePace =
  | "unverified"
  | "open"
  | "guarded"
  | "critical"
  | "reserve"

export type AutonomousAdmissionDecision =
  | {
      readonly allowed: true
      readonly pace: UsagePace
      readonly throttleRatio: number
      readonly grantedTokens?: number
    }
  | {
      readonly allowed: false
      readonly pace: UsagePace
      readonly throttleRatio: number
      readonly retryAt: number
      readonly grantedTokens?: 0
    }

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const isUsagePace = (value: unknown): value is UsagePace =>
  value === "unverified" ||
  value === "open" ||
  value === "guarded" ||
  value === "critical" ||
  value === "reserve"

export const parseAutonomousAdmission = (
  value: unknown,
): AutonomousAdmissionDecision | undefined => {
  if (!isRecord(value) || !isRecord(value.admission)) return undefined
  const { admission } = value
  if (
    !isRecord(admission.policy) ||
    !isUsagePace(admission.policy.pace) ||
    typeof admission.policy.throttleRatio !== "number" ||
    !Number.isFinite(admission.policy.throttleRatio) ||
    admission.policy.throttleRatio < 0 ||
    admission.policy.throttleRatio > 1
  )
    return undefined
  const grantedTokens =
    typeof admission.grantedTokens === "number" &&
    Number.isSafeInteger(admission.grantedTokens) &&
    admission.grantedTokens >= 0
      ? admission.grantedTokens
      : undefined
  if (admission.grantedTokens !== undefined && grantedTokens === undefined)
    return undefined
  if (admission.allowed === true)
    return {
      allowed: true,
      pace: admission.policy.pace,
      throttleRatio: admission.policy.throttleRatio,
      ...(grantedTokens === undefined ? {} : { grantedTokens }),
    }
  if (
    admission.allowed !== false ||
    typeof admission.retryAt !== "number" ||
    !Number.isSafeInteger(admission.retryAt) ||
    admission.retryAt < 0
  )
    return undefined
  if (grantedTokens !== undefined && grantedTokens !== 0) return undefined
  return {
    allowed: false,
    pace: admission.policy.pace,
    throttleRatio: admission.policy.throttleRatio,
    retryAt: admission.retryAt,
    ...(grantedTokens === 0 ? { grantedTokens: 0 as const } : {}),
  }
}

const controlPlanePort = (
  portValue: string | undefined,
): number | undefined => {
  const port = portValue === undefined ? 43_121 : Number(portValue)
  return Number.isSafeInteger(port) &&
    port >= 1 &&
    port <= 65_535 &&
    (portValue === undefined || /^\d+$/u.test(portValue))
    ? port
    : undefined
}

export const controlPlaneUsageUrl = (
  portValue: string | undefined,
): string | undefined => {
  const port = controlPlanePort(portValue)
  return port === undefined ? undefined : `http://127.0.0.1:${port}/v1/usage`
}

export const controlPlaneUsageControlUrl = (
  portValue: string | undefined,
): string | undefined => {
  const usageUrl = controlPlaneUsageUrl(portValue)
  return usageUrl ? `${usageUrl}/control` : undefined
}

const AUTONOMOUS_ROLE =
  /^(?:general|reviewer|yielduck-operator|moneymentum-operator)$/u

export const autonomousRoleForCwd = (
  cwd: string,
  home: string | undefined,
): string => {
  if (!home) return "general"
  if (cwd === `${home}/code/dataclique/yielduck`) return "yielduck-operator"
  if (cwd === `${home}/code/dataclique/moneymentum`)
    return "moneymentum-operator"
  if (
    cwd === `${home}/code/dataclique` ||
    cwd === `${home}/code/st0x` ||
    cwd === `${home}/code/0xgleb`
  )
    return "reviewer"
  return "general"
}

export const controlPlaneUsageAdmissionUrl = (
  portValue: string | undefined,
  role: string,
  request: {
    readonly kind?: "turn" | "workflow"
    readonly requestedTokens?: number
  } = {},
): string | undefined => {
  const usageUrl = controlPlaneUsageUrl(portValue)
  if (!usageUrl || !AUTONOMOUS_ROLE.test(role)) return undefined
  const kind = request.kind ?? "turn"
  if (kind === "turn" && request.requestedTokens !== undefined) return undefined
  if (
    kind === "workflow" &&
    (!Number.isSafeInteger(request.requestedTokens) ||
      (request.requestedTokens ?? 0) < 4_000 ||
      (request.requestedTokens ?? 0) > 5_000_000)
  )
    return undefined
  const parameters = new URLSearchParams({ role })
  if (kind === "workflow") {
    parameters.set("kind", "workflow")
    parameters.set("requestedTokens", String(request.requestedTokens))
  }
  return `${usageUrl}/admit?${parameters.toString()}`
}

export type AllowanceCheckpointInput =
  | {
      readonly capturedAt: number
      readonly remainingPercent: number
      readonly resetAt: number
    }
  | {
      readonly capturedAt: number
      readonly event: "refill"
      readonly remainingPercent: number
    }

export type ManualAllowancePool =
  | "chatgpt-shared-weekly"
  | "codex-app-server-weekly"

export type ManualAllowanceCheckpointRequest = AllowanceCheckpointInput & {
  readonly provider: "openai"
  readonly pool: ManualAllowancePool
  readonly source: "manual"
}

export const manualAllowanceCheckpointRequest = (
  checkpoint: AllowanceCheckpointInput,
  pool: ManualAllowancePool = "chatgpt-shared-weekly",
): ManualAllowanceCheckpointRequest => ({
  provider: "openai",
  pool,
  source: "manual",
  ...checkpoint,
})

const ISO_INSTANT =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/u

const parseInstant = (value: string): number | undefined => {
  if (!ISO_INSTANT.test(value)) return undefined
  const timestamp = Date.parse(value)
  return Number.isSafeInteger(timestamp) && timestamp >= 0
    ? timestamp
    : undefined
}

export const parseAllowanceCheckpointInput = (
  input: string,
  now = Date.now(),
): AllowanceCheckpointInput | undefined => {
  const [remainingText, resetText, capturedText, ...extra] = input
    .trim()
    .split(/\s+/u)
  if (
    !remainingText ||
    !resetText ||
    extra.length > 0 ||
    !/^\d{1,3}(?:\.\d{1,2})?$/u.test(remainingText)
  )
    return undefined
  const remainingPercent = Number(remainingText)
  const capturedAt = capturedText ? parseInstant(capturedText) : now
  if (
    !isAllowanceRemainingPercent(remainingPercent) ||
    capturedAt === undefined ||
    !Number.isSafeInteger(capturedAt) ||
    capturedAt < 0
  )
    return undefined
  if (resetText === "refill") {
    if (!capturedText) return undefined
    return { capturedAt, event: "refill", remainingPercent }
  }
  const resetAt = parseInstant(resetText)
  if (resetAt === undefined || resetAt <= capturedAt) return undefined
  return { capturedAt, remainingPercent, resetAt }
}

export const parsePersistedModelRef = (
  value: unknown,
): PersistedModelRef | undefined => {
  if (
    typeof value !== "object" ||
    value === null ||
    !("provider" in value) ||
    typeof value.provider !== "string" ||
    value.provider.length === 0 ||
    !("id" in value) ||
    typeof value.id !== "string" ||
    value.id.length === 0
  )
    return undefined
  const thinking =
    "thinking" in value &&
    (value.thinking === "off" ||
      value.thinking === "minimal" ||
      value.thinking === "low" ||
      value.thinking === "medium" ||
      value.thinking === "high" ||
      value.thinking === "xhigh" ||
      value.thinking === "max")
      ? value.thinking
      : undefined
  if ("thinking" in value && thinking === undefined) return undefined
  return {
    provider: value.provider,
    id: value.id,
    ...(thinking ? { thinking } : {}),
  }
}
