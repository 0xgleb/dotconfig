export const HOUR_MS = 60 * 60_000
export const RELEASE_TARGET_MS = 3 * HOUR_MS

export interface LiveReleaseMarker {
  readonly version: string
  readonly at: number
}

export interface ReleaseCadenceState {
  readonly enabled: boolean
  readonly lastReminderBoundaryAt: number
  readonly latestRelease?: LiveReleaseMarker
  readonly lastTriggeredReleaseAt?: number
}

export interface DueReleaseCadenceReminder {
  readonly boundaryAt: number
  readonly nextState: ReleaseCadenceState
  readonly content: string
  readonly cadenceFailure: boolean
  readonly triggerTurn: true
}

export const hourBoundaryAt = (now: number): number =>
  Math.floor(now / HOUR_MS) * HOUR_MS

export const nextHourBoundaryAt = (now: number): number =>
  hourBoundaryAt(now) + HOUR_MS

export const initialReleaseCadenceState = (
  now: number,
): ReleaseCadenceState => ({
  enabled: true,
  lastReminderBoundaryAt: hourBoundaryAt(now),
})

export const restoreReleaseCadenceState = (
  state: ReleaseCadenceState,
  now: number,
): ReleaseCadenceState => ({
  ...state,
  lastReminderBoundaryAt: hourBoundaryAt(now),
})

const elapsedText = (elapsedMs: number): string => {
  const totalMinutes = Math.max(0, Math.floor(elapsedMs / 60_000))
  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`
}

const utcHourMinute = (timestamp: number): string =>
  new Date(timestamp).toISOString().slice(11, 16)

export const dueReleaseCadenceReminder = (
  state: ReleaseCadenceState,
  now: number,
): DueReleaseCadenceReminder | undefined => {
  if (!state.enabled) return undefined
  const boundaryAt = hourBoundaryAt(now)
  if (boundaryAt <= state.lastReminderBoundaryAt) return undefined

  const elapsedMs = state.latestRelease
    ? Math.max(0, now - state.latestRelease.at)
    : undefined
  const cadenceFailure =
    elapsedMs !== undefined && elapsedMs > RELEASE_TARGET_MS
  const nextShipBoundary = nextHourBoundaryAt(boundaryAt)
  const marker = state.latestRelease
    ? `${state.latestRelease.version} at ${new Date(state.latestRelease.at).toISOString()} (${elapsedText(elapsedMs ?? 0)} elapsed)`
    : "unavailable; verify the latest live version marker through the safe dashboard API"
  const urgency = cadenceFailure
    ? "CADENCE FAILURE: more than three hours have elapsed since the latest verified live release."
    : "HOURLY RELEASE CHECK: continue the highest-priority executable release work."
  const content = [
    urgency,
    `Latest verified live release: ${marker}.`,
    `Next hourly ship boundary: ${new Date(nextShipBoundary).toISOString()} (${utcHourMinute(nextShipBoundary)} UTC).`,
    "Aim for at least one live release inside the three-hour verified-release target.",
    "Patch remains the default release; use minor only for a completed capability milestone under repository policy.",
    "Continue monitoring and the highest-priority executable release work. This reminder does not widen authority.",
  ].join("\n")

  return {
    boundaryAt,
    nextState: {
      ...state,
      lastReminderBoundaryAt: boundaryAt,
      ...(state.latestRelease
        ? { lastTriggeredReleaseAt: state.latestRelease.at }
        : {}),
    },
    content,
    cadenceFailure,
    triggerTurn: true,
  }
}
