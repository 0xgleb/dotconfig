export const WEEK_MS = 7 * 24 * 60 * 60 * 1_000
export const MAX_ALLOWANCE_CHECKPOINT_AGE_MS = 12 * 60 * 60 * 1_000
export const MAX_ALLOWANCE_PERCENT = 200
export const MIN_WORKFLOW_TOKEN_BUDGET = 4_000

export const isAllowanceRemainingPercent = (value: unknown): value is number =>
  typeof value === "number" &&
  Number.isFinite(value) &&
  value >= 0 &&
  value <= MAX_ALLOWANCE_PERCENT

const HOUR_MS = 60 * 60 * 1_000
const MIN_BURN_SAMPLE_INTERVAL_MS = 5 * 60 * 1_000
const BURN_RATE_HALF_LIFE_MS = 12 * HOUR_MS
const AUTONOMOUS_RESERVE_PERCENT = 3
const HARD_RESERVE_PERCENT = 5
const MIN_THROTTLE_RATIO = 0.02
const AGENT_ALLOCATION_FLOOR = 0.25
const AGENT_INTERVENTION_HALF_LIFE_MS = 2 * HOUR_MS

export type UsagePace =
  | "unverified"
  | "open"
  | "guarded"
  | "critical"
  | "reserve"

export type AllowanceCheckpointInput =
  | {
      readonly capturedAt: number
      readonly remainingPercent: number
      readonly resetAt: number
      readonly event?: undefined
    }
  | {
      readonly capturedAt: number
      readonly remainingPercent: number
      readonly event: "refill"
    }

type ResetAllowanceCheckpoint = Exclude<
  AllowanceCheckpointInput,
  { readonly event: "refill" }
>

export interface UsagePolicy {
  readonly pace: UsagePace
  readonly minimumIntervalMs: number
  readonly throttleRatio: number
  readonly targetRemainingPercent?: number
  readonly actualRemainingPercent?: number
  readonly runwayStartedAt?: number
  readonly resetAt?: number
  readonly planningHorizonAt?: number
  readonly observedBurnPercentPerHour?: number
  readonly permittedBurnPercentPerHour?: number
  readonly estimatedExhaustionAt?: number
}

export interface AllowanceRunway {
  readonly latest: AllowanceCheckpointInput
  readonly anchor: AllowanceCheckpointInput
  readonly targetRemainingPercent: number
  readonly planningHorizonAt: number
}

export type AutonomousRole =
  | "general"
  | "reviewer"
  | "yielduck-operator"
  | "moneymentum-operator"

export interface RolePollingPolicy {
  readonly role: AutonomousRole
  readonly baseIntervalMs: number
  readonly weight: number
  readonly effectiveIntervalMs: number
  readonly tokenScale: number
}

export interface WorkflowTokenBudget {
  readonly allowed: boolean
  readonly requestedTokens: number
  readonly grantedTokens: number
}

export interface ProviderUsagePoint {
  readonly agentId: string
  readonly capturedAt: number
  readonly model?: string
  readonly usage: { readonly totalTokens: number }
}

export interface ProviderTokenCalibration {
  readonly observedBurnPercent: number
  readonly observedTokens: number
  readonly tokensPerPercent: number
}

export interface ProviderTokenPolicy {
  readonly capacityTokens: number
  readonly permittedTokensPerHour: number
  readonly windowMs: number
}

const PROVIDER_BUDGET_WINDOW_MS = 4 * HOUR_MS

const usageAt = (
  samples: readonly ProviderUsagePoint[],
  agentId: string,
  at: number,
): number =>
  samples
    .filter(sample => sample.agentId === agentId && sample.capturedAt <= at)
    .toSorted((left, right) => left.capturedAt - right.capturedAt)
    .at(-1)?.usage.totalTokens ?? 0

export const calibrateProviderTokens = (
  checkpoints: readonly AllowanceCheckpointInput[],
  samples: readonly ProviderUsagePoint[],
): ProviderTokenCalibration | undefined => {
  const ordered = checkpoints.toSorted(
    (left, right) => left.capturedAt - right.capturedAt,
  )
  let observedBurnPercent = 0
  let observedTokens = 0
  for (const [index, current] of ordered.entries()) {
    const previous = ordered[index - 1]
    if (
      !previous ||
      previous.event === "refill" ||
      current.event === "refill" ||
      previous.resetAt !== current.resetAt ||
      current.remainingPercent >= previous.remainingPercent ||
      current.capturedAt <= previous.capturedAt
    )
      continue
    const agentIds = new Set(
      samples
        .filter(
          sample =>
            sample.capturedAt >= previous.capturedAt &&
            sample.capturedAt <= current.capturedAt &&
            sample.model?.startsWith("openai") === true,
        )
        .map(sample => sample.agentId),
    )
    const intervalTokens = [...agentIds].reduce((total, agentId) => {
      const start = usageAt(samples, agentId, previous.capturedAt)
      const end = usageAt(samples, agentId, current.capturedAt)
      return total + Math.max(0, end - start)
    }, 0)
    if (intervalTokens <= 0) continue
    observedBurnPercent += previous.remainingPercent - current.remainingPercent
    observedTokens += intervalTokens
  }
  if (observedBurnPercent <= 0 || observedTokens <= 0) return undefined
  const tokensPerPercent = observedTokens / observedBurnPercent
  return Number.isFinite(tokensPerPercent) && tokensPerPercent > 0
    ? { observedBurnPercent, observedTokens, tokensPerPercent }
    : undefined
}

export const providerTokenPolicy = (
  usage: UsagePolicy,
  calibration: ProviderTokenCalibration | undefined,
): ProviderTokenPolicy | undefined => {
  const permittedBurnPercentPerHour = usage.permittedBurnPercentPerHour
  if (
    !calibration ||
    permittedBurnPercentPerHour === undefined ||
    usage.throttleRatio <= 0
  )
    return undefined
  const permittedTokensPerHour = Math.floor(
    permittedBurnPercentPerHour * calibration.tokensPerPercent,
  )
  const capacityTokens = Math.floor(
    permittedTokensPerHour * (PROVIDER_BUDGET_WINDOW_MS / HOUR_MS),
  )
  return permittedTokensPerHour >= 1 && capacityTokens >= 1
    ? {
        capacityTokens,
        permittedTokensPerHour,
        windowMs: PROVIDER_BUDGET_WINDOW_MS,
      }
    : undefined
}
const ROLE_POLLING_CONFIG: Readonly<
  Record<
    AutonomousRole,
    { readonly baseIntervalMs: number; readonly weight: number }
  >
> = {
  "general": { baseIntervalMs: 4 * HOUR_MS, weight: 1 },
  "reviewer": { baseIntervalMs: 4 * HOUR_MS, weight: 1 },
  "yielduck-operator": { baseIntervalMs: 4 * HOUR_MS, weight: 1 },
  "moneymentum-operator": { baseIntervalMs: 4 * HOUR_MS, weight: 1 },
}

const PACE_PRESSURE: Readonly<Record<UsagePace, number>> = {
  open: 1,
  guarded: 2,
  critical: 4,
  reserve: 12,
  unverified: 4,
}

export const isAutonomousRole = (role: unknown): role is AutonomousRole =>
  role === "general" ||
  role === "reviewer" ||
  role === "yielduck-operator" ||
  role === "moneymentum-operator"

const autonomousRole = (role: string): AutonomousRole =>
  isAutonomousRole(role) ? role : "general"

const clampRatio = (value: number): number => Math.max(0, Math.min(1, value))

export const effectiveThrottleRatio = (
  sustainableThrottleRatio: number,
  ownerInteractionAt: number | undefined,
  now: number,
): number => {
  const sustainableRatio = clampRatio(sustainableThrottleRatio)
  if (sustainableRatio === 0 || sustainableRatio === 1) return sustainableRatio
  if (
    ownerInteractionAt === undefined ||
    !Number.isSafeInteger(ownerInteractionAt) ||
    ownerInteractionAt < 0 ||
    ownerInteractionAt > now
  )
    return sustainableRatio

  const recency =
    2 ** (-(now - ownerInteractionAt) / AGENT_INTERVENTION_HALF_LIFE_MS)
  return sustainableRatio + (1 - sustainableRatio) * recency
}

export const applyInteractionPacing = (
  sustainableIntervalMs: number,
  sustainableThrottleRatio: number,
  currentThrottleRatio: number,
): number => {
  if (sustainableIntervalMs <= 0) return 0
  const sustainableRatio = clampRatio(sustainableThrottleRatio)
  const currentRatio = clampRatio(currentThrottleRatio)
  if (sustainableRatio === 0 || currentRatio <= sustainableRatio)
    return sustainableIntervalMs
  return Math.ceil(sustainableIntervalMs * (sustainableRatio / currentRatio))
}

export const rolePollingPolicy = (
  requestedRole: string,
  pace: UsagePace,
  throttleRatio = 1 / PACE_PRESSURE[pace],
): RolePollingPolicy => {
  const role = autonomousRole(requestedRole)
  const config = ROLE_POLLING_CONFIG[role]
  const boundedRatio = clampRatio(throttleRatio)
  const roleRatio = clampRatio(boundedRatio * config.weight)
  const effectiveIntervalMs =
    roleRatio === 0
      ? WEEK_MS
      : pace === "open" && boundedRatio === 1
        ? 60_000
        : Math.ceil(config.baseIntervalMs / roleRatio)
  return {
    role,
    ...config,
    effectiveIntervalMs: Math.max(
      60_000,
      Math.min(WEEK_MS, effectiveIntervalMs),
    ),
    tokenScale: pace === "reserve" ? 0 : roleRatio,
  }
}

export const workflowTokenBudget = (
  requestedTokens: number,
  rolePolicy: RolePollingPolicy,
): WorkflowTokenBudget => {
  if (!Number.isSafeInteger(requestedTokens) || requestedTokens < 1)
    return { allowed: false, requestedTokens, grantedTokens: 0 }
  const grantedTokens =
    Math.floor((requestedTokens * rolePolicy.tokenScale) / 1_000) * 1_000
  return {
    allowed: grantedTokens >= MIN_WORKFLOW_TOKEN_BUDGET,
    requestedTokens,
    grantedTokens: Math.max(0, grantedTokens),
  }
}

const policy = (
  pace: UsagePace,
  minimumIntervalMs: number,
  throttleRatio: number,
  checkpoint?: AllowanceCheckpointInput,
  targetRemainingPercent?: number,
  runwayStartedAt?: number,
  planningHorizonAt?: number,
  burn?: {
    readonly observedBurnPercentPerHour: number
    readonly permittedBurnPercentPerHour: number
    readonly estimatedExhaustionAt: number
  },
): UsagePolicy => ({
  pace,
  minimumIntervalMs,
  throttleRatio,
  ...(checkpoint
    ? {
        actualRemainingPercent: checkpoint.remainingPercent,
        ...(checkpoint.event === "refill"
          ? {}
          : { resetAt: checkpoint.resetAt }),
      }
    : {}),
  ...(targetRemainingPercent === undefined ? {} : { targetRemainingPercent }),
  ...(runwayStartedAt === undefined ? {} : { runwayStartedAt }),
  ...(planningHorizonAt === undefined
    ? checkpoint === undefined
      ? {}
      : {
          planningHorizonAt:
            checkpoint.event === "refill"
              ? checkpoint.capturedAt + WEEK_MS
              : checkpoint.resetAt,
        }
    : { planningHorizonAt }),
  ...burn,
})

const planningHorizon = (
  defaultHorizonAt: number,
  now: number,
  capacityReliefAt: number | undefined,
): number =>
  Number.isSafeInteger(capacityReliefAt) &&
  capacityReliefAt !== undefined &&
  capacityReliefAt > now &&
  capacityReliefAt < defaultHorizonAt
    ? capacityReliefAt
    : defaultHorizonAt

export const allowanceRunway = (
  checkpoints: readonly AllowanceCheckpointInput[],
  now: number,
  capacityReliefAt?: number,
): AllowanceRunway | undefined => {
  const eligible = checkpoints
    .filter(checkpoint => {
      const { capturedAt, remainingPercent } = checkpoint
      if (
        !Number.isSafeInteger(capturedAt) ||
        capturedAt < 0 ||
        capturedAt > now ||
        !isAllowanceRemainingPercent(remainingPercent)
      )
        return false
      return (
        checkpoint.event === "refill" ||
        (Number.isSafeInteger(checkpoint.resetAt) &&
          checkpoint.resetAt > capturedAt)
      )
    })
    .toSorted((left, right) => left.capturedAt - right.capturedAt)
  const latest = eligible.at(-1)
  if (!latest || now - latest.capturedAt > MAX_ALLOWANCE_CHECKPOINT_AGE_MS)
    return undefined

  if (latest.event === "refill") {
    const defaultPlanningHorizonAt = latest.capturedAt + WEEK_MS
    const planningHorizonAt = planningHorizon(
      defaultPlanningHorizonAt,
      now,
      capacityReliefAt,
    )
    if (!Number.isSafeInteger(planningHorizonAt) || now >= planningHorizonAt)
      return undefined
    return {
      latest,
      anchor: latest,
      planningHorizonAt,
      targetRemainingPercent:
        latest.remainingPercent * ((planningHorizonAt - now) / WEEK_MS),
    }
  }
  if (now >= latest.resetAt) return undefined

  const cycle = eligible.filter(
    (checkpoint): checkpoint is ResetAllowanceCheckpoint =>
      checkpoint.event !== "refill" && checkpoint.resetAt === latest.resetAt,
  )
  const first = cycle[0]
  if (!first) return undefined
  const { anchor } = cycle.slice(1).reduce(
    (state, current) => ({
      anchor:
        current.remainingPercent > state.previous.remainingPercent
          ? current
          : state.anchor,
      previous: current,
    }),
    { anchor: first, previous: first },
  )
  const planningHorizonAt = planningHorizon(
    latest.resetAt,
    now,
    capacityReliefAt,
  )
  const runwayDuration = planningHorizonAt - anchor.capturedAt
  if (runwayDuration <= 0) return undefined

  const targetRemainingPercent = Math.max(
    0,
    Math.min(
      anchor.remainingPercent,
      anchor.remainingPercent * ((planningHorizonAt - now) / runwayDuration),
    ),
  )
  return {
    latest,
    anchor,
    planningHorizonAt,
    targetRemainingPercent,
  }
}

const observedBurnRate = (
  checkpoints: readonly AllowanceCheckpointInput[],
  now: number,
): number | undefined => {
  const ordered = [...checkpoints].sort(
    (left, right) => left.capturedAt - right.capturedAt,
  )
  const segmentStart = ordered.reduce(
    (start, current, index) =>
      index > 0 &&
      current.remainingPercent > (ordered[index - 1]?.remainingPercent ?? 100)
        ? index
        : start,
    0,
  )
  const segment = ordered.slice(segmentStart)
  const observations = segment.flatMap((current, index) => {
    const previous = segment[index - 1]
    if (!previous) return []
    const elapsedMs = current.capturedAt - previous.capturedAt
    const consumedPercent = previous.remainingPercent - current.remainingPercent
    if (
      elapsedMs < MIN_BURN_SAMPLE_INTERVAL_MS ||
      consumedPercent < 0 ||
      current.capturedAt > now
    )
      return []
    const ageMs = Math.max(0, now - current.capturedAt)
    return [
      {
        rate: (consumedPercent * HOUR_MS) / elapsedMs,
        weight: elapsedMs * 2 ** (-ageMs / BURN_RATE_HALF_LIFE_MS),
      },
    ]
  })
  const totalWeight = observations.reduce(
    (total, observation) => total + observation.weight,
    0,
  )
  if (totalWeight === 0) return undefined
  return (
    observations.reduce(
      (total, observation) => total + observation.rate * observation.weight,
      0,
    ) / totalWeight
  )
}

const continuousMinimumInterval = (throttleRatio: number): number =>
  throttleRatio >= 1
    ? 0
    : Math.min(
        WEEK_MS,
        Math.ceil((15 * 60 * 1_000) / Math.max(0.01, throttleRatio)),
      )

export interface AgentAllocation {
  readonly configuredWeight: number
  readonly recencyFactor: number
  readonly effectiveWeight: number
}

const configuredAgentWeight = (cwd: string): number =>
  /\/code\/st0x(?:\/|$)/u.test(cwd) ? 2 : 1

export const agentAllocation = (
  cwd: string,
  ownerInteractionAt: number | undefined,
  now: number,
): AgentAllocation => {
  const configuredWeight = configuredAgentWeight(cwd)
  const ageMs =
    ownerInteractionAt !== undefined &&
    Number.isSafeInteger(ownerInteractionAt) &&
    ownerInteractionAt >= 0 &&
    ownerInteractionAt <= now
      ? now - ownerInteractionAt
      : Number.POSITIVE_INFINITY
  const recencyFactor =
    ageMs === Number.POSITIVE_INFINITY
      ? AGENT_ALLOCATION_FLOOR
      : AGENT_ALLOCATION_FLOOR +
        (1 - AGENT_ALLOCATION_FLOOR) *
          2 ** (-ageMs / AGENT_INTERVENTION_HALF_LIFE_MS)

  return {
    configuredWeight,
    recencyFactor,
    effectiveWeight: configuredWeight * recencyFactor,
  }
}

export const usagePolicy = (
  checkpoints: readonly AllowanceCheckpointInput[],
  now: number,
  capacityReliefAt?: number,
): UsagePolicy => {
  const runway = allowanceRunway(checkpoints, now, capacityReliefAt)
  if (!runway) return policy("unverified", 60 * 60 * 1_000, 0.25)

  const {
    latest: checkpoint,
    anchor,
    planningHorizonAt,
    targetRemainingPercent,
  } = runway
  const cycle = checkpoints.filter(
    candidate =>
      candidate.capturedAt >= anchor.capturedAt &&
      candidate.capturedAt <= now &&
      (checkpoint.event === "refill"
        ? candidate.event === "refill" ||
          candidate.capturedAt > checkpoint.capturedAt
        : candidate.event !== "refill" &&
          candidate.resetAt === checkpoint.resetAt),
  )
  const observedBurnPercentPerHour = observedBurnRate(cycle, now)
  if (observedBurnPercentPerHour === undefined)
    return checkpoint.remainingPercent <= HARD_RESERVE_PERCENT
      ? policy(
          "reserve",
          WEEK_MS,
          0,
          checkpoint,
          targetRemainingPercent,
          anchor.capturedAt,
          planningHorizonAt,
        )
      : policy(
          "unverified",
          60 * 60 * 1_000,
          0.25,
          checkpoint,
          targetRemainingPercent,
          anchor.capturedAt,
          planningHorizonAt,
        )

  const remainingHours = Math.max(
    (planningHorizonAt - now) / HOUR_MS,
    Number.EPSILON,
  )
  const permittedBurnPercentPerHour =
    Math.max(0, checkpoint.remainingPercent - AUTONOMOUS_RESERVE_PERCENT) /
    remainingHours
  const rawThrottleRatio = clampRatio(
    permittedBurnPercentPerHour / observedBurnPercentPerHour,
  )
  const throttleRatio =
    checkpoint.remainingPercent <= HARD_RESERVE_PERCENT ||
    rawThrottleRatio < MIN_THROTTLE_RATIO
      ? 0
      : rawThrottleRatio
  const pace: UsagePace =
    throttleRatio === 0
      ? "reserve"
      : throttleRatio < 0.5
        ? "critical"
        : throttleRatio < 0.8
          ? "guarded"
          : "open"
  const estimatedExhaustionAt = Math.min(
    planningHorizonAt,
    now +
      Math.floor(
        (checkpoint.remainingPercent / observedBurnPercentPerHour) * HOUR_MS,
      ),
  )
  return policy(
    pace,
    continuousMinimumInterval(throttleRatio),
    throttleRatio,
    checkpoint,
    targetRemainingPercent,
    anchor.capturedAt,
    planningHorizonAt,
    {
      observedBurnPercentPerHour,
      permittedBurnPercentPerHour,
      estimatedExhaustionAt,
    },
  )
}
