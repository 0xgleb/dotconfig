import type { ProviderAllowanceCheckpoint } from "../allowance-pool.ts"
import type { AllowanceCheckpointInput } from "../usage-policy.ts"

export type AllowanceHistoryEvent =
  "cycle-start" | "provider-reset" | "exhaustion" | "bailout"

export interface InferredAllowanceBailout {
  readonly capturedAt: number
  readonly increasePercent: number
}

export type AllowanceChartPoint = AllowanceCheckpointInput & {
  readonly evidence: "observed" | "estimated"
  readonly historyEvent?: AllowanceHistoryEvent
}

export interface ReconstructedAllowanceHistory {
  readonly points: readonly AllowanceChartPoint[]
}

const WEEK_MS = 7 * 24 * 60 * 60 * 1_000
const ESTIMATED_EXHAUSTION_LEAD_MS = 15 * 60 * 1_000

const isLegacyAllowance = (checkpoint: ProviderAllowanceCheckpoint): boolean =>
  checkpoint.provider === "legacy" && checkpoint.pool === "generic"

const isChatGptSharedAllowance = (
  checkpoint: ProviderAllowanceCheckpoint,
): boolean =>
  checkpoint.provider === "openai" &&
  checkpoint.pool === "chatgpt-shared-weekly"

export const reconstructChatGptSharedHistory = (
  checkpoints: readonly ProviderAllowanceCheckpoint[],
): ReconstructedAllowanceHistory => {
  const observed = checkpoints
    .filter(
      checkpoint =>
        isLegacyAllowance(checkpoint) || isChatGptSharedAllowance(checkpoint),
    )
    .sort((left, right) => left.capturedAt - right.capturedAt)
  const first = observed[0]
  if (!first) return { points: [] }

  const points: AllowanceChartPoint[] = []
  if (first.event !== "refill") {
    const cycleStartAt = first.resetAt - WEEK_MS
    if (
      isLegacyAllowance(first) &&
      first.remainingPercent < 100 &&
      cycleStartAt >= 0 &&
      cycleStartAt < first.capturedAt
    )
      points.push({
        capturedAt: cycleStartAt,
        remainingPercent: 100,
        resetAt: first.resetAt,
        evidence: "estimated",
        historyEvent: "cycle-start",
      })
  }

  observed.forEach((checkpoint, index) => {
    if (checkpoint.event === "refill") {
      points.push({
        ...checkpoint,
        evidence:
          checkpoint.source === "estimated-history" ? "estimated" : "observed",
      })
      return
    }
    const previous = observed[index - 1]
    if (
      previous &&
      previous.event !== "refill" &&
      isLegacyAllowance(previous) &&
      isLegacyAllowance(checkpoint) &&
      checkpoint.remainingPercent > previous.remainingPercent
    )
      points.push({
        capturedAt:
          previous.capturedAt +
          Math.floor((checkpoint.capturedAt - previous.capturedAt) / 2),
        remainingPercent: 100,
        resetAt: checkpoint.resetAt,
        evidence: "estimated",
        historyEvent: "provider-reset",
      })

    const isBailout =
      previous !== undefined &&
      previous.event !== "refill" &&
      isLegacyAllowance(previous) &&
      isChatGptSharedAllowance(checkpoint) &&
      checkpoint.remainingPercent === 100
    if (isBailout && previous && previous.event !== "refill")
      points.push({
        capturedAt: Math.max(
          previous.capturedAt + 1,
          checkpoint.capturedAt - ESTIMATED_EXHAUSTION_LEAD_MS,
        ),
        remainingPercent: 0,
        resetAt: previous.resetAt,
        evidence: "estimated",
        historyEvent: "exhaustion",
      })

    points.push({
      ...checkpoint,
      evidence:
        checkpoint.source === "estimated-history" ? "estimated" : "observed",
      ...(isBailout ? { historyEvent: "bailout" as const } : {}),
    })
  })

  return { points: allowanceChartCheckpoints(points) }
}

export interface AllowanceChartDomain {
  readonly startAt: number
  readonly endAt: number
}

export const allowanceChartCheckpoints = <
  Checkpoint extends AllowanceCheckpointInput,
>(
  checkpoints: readonly Checkpoint[],
): readonly Checkpoint[] =>
  [...checkpoints].sort((left, right) => left.capturedAt - right.capturedAt)

export const allowanceChartDomain = (
  checkpoints: readonly AllowanceCheckpointInput[],
): AllowanceChartDomain | undefined => {
  const ordered = allowanceChartCheckpoints(checkpoints)
  const first = ordered[0]
  const latest = ordered.at(-1)
  if (!first || !latest) return undefined
  const endAt =
    latest.event === "refill"
      ? latest.capturedAt
      : Math.max(latest.capturedAt, latest.resetAt)
  return endAt > first.capturedAt
    ? { startAt: first.capturedAt, endAt }
    : undefined
}

export const allowanceChartX = (
  capturedAt: number,
  domain: AllowanceChartDomain | undefined,
): number => {
  if (!domain) return 0
  return Math.max(
    0,
    Math.min(
      100,
      ((capturedAt - domain.startAt) / (domain.endAt - domain.startAt)) * 100,
    ),
  )
}

export const allowanceChartSegments = (
  checkpoints: readonly AllowanceCheckpointInput[],
): readonly (readonly AllowanceCheckpointInput[])[] => {
  const ordered = allowanceChartCheckpoints(checkpoints)
  return ordered.reduce<AllowanceCheckpointInput[][]>(
    (segments, checkpoint) => {
      const active = segments.at(-1)
      const previous = active?.at(-1)
      if (
        !active ||
        !previous ||
        checkpoint.event === "refill" ||
        previous.event === "refill" ||
        checkpoint.resetAt !== previous.resetAt ||
        checkpoint.remainingPercent > previous.remainingPercent
      ) {
        segments.push([checkpoint])
      } else {
        active.push(checkpoint)
      }
      return segments
    },
    [],
  )
}

export const inferredAllowanceBailouts = (
  checkpoints: readonly AllowanceCheckpointInput[],
): readonly InferredAllowanceBailout[] => {
  const ordered = allowanceChartCheckpoints(checkpoints)
  return ordered.flatMap((current, index) => {
    const previous = ordered[index - 1]
    return previous &&
      previous.event !== "refill" &&
      current.event !== "refill" &&
      current.remainingPercent > previous.remainingPercent &&
      current.capturedAt < previous.resetAt
      ? [
          {
            capturedAt: current.capturedAt,
            increasePercent:
              current.remainingPercent - previous.remainingPercent,
          },
        ]
      : []
  })
}
