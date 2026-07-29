export const QUARTER_HOUR_MS = 15 * 60_000;
export const HOUR_MS = 60 * 60_000;

export interface LiveReleaseMarker {
  readonly version: string;
  readonly at: number;
}

export interface ReleaseCadenceState {
  readonly enabled: boolean;
  readonly lastReminderBoundaryAt: number;
  readonly latestRelease?: LiveReleaseMarker;
}

export interface DueReleaseCadenceReminder {
  readonly boundaryAt: number;
  readonly nextState: ReleaseCadenceState;
  readonly content: string;
  readonly cadenceFailure: boolean;
}

export const quarterBoundaryAt = (now: number): number => Math.floor(now / QUARTER_HOUR_MS) * QUARTER_HOUR_MS;

export const nextQuarterBoundaryAt = (now: number): number => quarterBoundaryAt(now) + QUARTER_HOUR_MS;

export const nextTopOfHourAt = (now: number): number => Math.floor(now / HOUR_MS) * HOUR_MS + HOUR_MS;

export const initialReleaseCadenceState = (now: number): ReleaseCadenceState => ({
  enabled: true,
  lastReminderBoundaryAt: quarterBoundaryAt(now),
});

const elapsedText = (elapsedMs: number): string => {
  const totalMinutes = Math.max(0, Math.floor(elapsedMs / 60_000));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
};

const utcHourMinute = (timestamp: number): string =>
  new Date(timestamp).toISOString().slice(11, 16);

export const dueReleaseCadenceReminder = (
  state: ReleaseCadenceState,
  now: number,
): DueReleaseCadenceReminder | undefined => {
  if (!state.enabled) return undefined;
  const boundaryAt = quarterBoundaryAt(now);
  if (boundaryAt <= state.lastReminderBoundaryAt) return undefined;

  const minute = new Date(boundaryAt).getUTCMinutes();
  const topOfHour = minute === 0;
  const prepareToShip = minute === 45;
  const elapsedMs = state.latestRelease ? Math.max(0, now - state.latestRelease.at) : undefined;
  const cadenceFailure = topOfHour && elapsedMs !== undefined && elapsedMs > HOUR_MS;
  const nextShipBoundary = nextTopOfHourAt(boundaryAt);
  const marker = state.latestRelease
    ? `${state.latestRelease.version} at ${new Date(state.latestRelease.at).toISOString()} (${elapsedText(elapsedMs ?? 0)} elapsed)`
    : "unavailable; verify the latest live version marker through the safe dashboard API";
  const urgency = cadenceFailure
    ? "CADENCE FAILURE: more than 60 minutes have elapsed since the latest verified live release."
    : prepareToShip
      ? "PREPARE TO SHIP: 15 minutes remain before the top-of-hour boundary."
      : topOfHour
        ? "TOP-OF-HOUR SHIP CHECK: verify a live patch landed inside the cadence window."
        : "Quarter-hour release cadence check.";
  const content = [
    urgency,
    `Latest verified live release: ${marker}.`,
    `Next top-of-hour ship boundary: ${new Date(nextShipBoundary).toISOString()} (${utcHourMinute(nextShipBoundary)} UTC).`,
    "Patch remains the default release; use minor only for a completed capability milestone under repository policy.",
    "Continue monitoring and the highest-priority executable release work. This reminder does not widen authority.",
  ].join("\n");

  return {
    boundaryAt,
    nextState: { ...state, lastReminderBoundaryAt: boundaryAt },
    content,
    cadenceFailure,
  };
};
