export interface ActiveLoopState {
  readonly status: "active";
  readonly instruction: string;
  readonly intervalMs: number;
  readonly startedAt: number;
  readonly nextRunAt: number;
  readonly runs: number;
  readonly lastRunAt?: number;
}

export interface ClearedLoopState {
  readonly status: "cleared";
  readonly instruction: string;
  readonly intervalMs: number;
  readonly startedAt: number;
  readonly nextRunAt: number;
  readonly runs: number;
  readonly finishedAt: number;
  readonly lastRunAt?: number;
}

export type LoopState = ActiveLoopState | ClearedLoopState;

export type LoopCommand =
  | { readonly action: "status" }
  | { readonly action: "clear" }
  | { readonly action: "set"; readonly instruction: string; readonly intervalMs: number };

export type LoopDispatch =
  | { readonly kind: "command"; readonly text: "/reload-runtime" }
  | { readonly kind: "prompt"; readonly text: string };

export const DEFAULT_LOOP_INTERVAL_MS = 60 * 60 * 1_000;
export const REVIEW_DUTY_LOOP_INTERVAL_MS = 2 * 60 * 60 * 1_000;
const LEGACY_REVIEW_DUTY_LOOP_INTERVAL_MS = 15 * 60 * 1_000;
const MIN_LOOP_INTERVAL_MS = 60 * 1_000;
const MAX_LOOP_INTERVAL_MS = 7 * 24 * 60 * 60 * 1_000;
const MAX_INSTRUCTION_LENGTH = 4_000;
const INTERVAL_MULTIPLIERS: Readonly<Record<string, number>> = {
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

export const parseLoopCommand: (args: string) => LoopCommand = (args) => {
  const input = args.trim();
  if (input.length === 0) return { action: "status" };
  if (input.toLowerCase() === "clear") return { action: "clear" };

  const match = /^(\d+)([smhd])\s+(.+)$/i.exec(input);
  const intervalMs = match ? parseInterval(Number(match[1]), match[2]?.toLowerCase() ?? "") : DEFAULT_LOOP_INTERVAL_MS;
  const instruction = (match?.[3] ?? input).trim();
  if (instruction.length === 0) throw new Error("Loop instructions must not be empty.");
  if (instruction.length > MAX_INSTRUCTION_LENGTH) {
    throw new Error("Loop instructions may contain at most 4,000 characters.");
  }
  return { action: "set", instruction, intervalMs };
};

export const parseStoredLoop: (value: unknown) => LoopState | undefined = (value) => {
  if (
    !isRecord(value) ||
    typeof value.instruction !== "string" ||
    value.instruction.length === 0 ||
    value.instruction.length > MAX_INSTRUCTION_LENGTH ||
    !isTimestamp(value.startedAt) ||
    !isTimestamp(value.nextRunAt) ||
    !isNonNegativeInteger(value.runs) ||
    !isValidInterval(value.intervalMs) ||
    (value.lastRunAt !== undefined && !isTimestamp(value.lastRunAt))
  ) {
    return undefined;
  }

  const shared = {
    instruction: value.instruction,
    intervalMs: value.intervalMs,
    startedAt: value.startedAt,
    nextRunAt: value.nextRunAt,
    runs: value.runs,
    ...(value.lastRunAt !== undefined ? { lastRunAt: value.lastRunAt } : {}),
  };
  if (value.status === "active") return { status: "active", ...shared };
  if (value.status === "cleared" && isTimestamp(value.finishedAt)) {
    return { status: "cleared", ...shared, finishedAt: value.finishedAt };
  }
  return undefined;
};

export const migrateLegacyReloadLoop: (condition: string, now: number) => ActiveLoopState | undefined = (
  condition,
  now,
) => {
  if (!/^\d+[smhd]\s+\/reload(?:\s|$)/i.test(condition.trim())) return undefined;
  try {
    const command = parseLoopCommand(condition);
    if (command.action !== "set") return undefined;
    return {
      status: "active",
      instruction: command.instruction,
      intervalMs: DEFAULT_LOOP_INTERVAL_MS,
      startedAt: now,
      nextRunAt: now + DEFAULT_LOOP_INTERVAL_MS,
      runs: 0,
    };
  } catch {
    return undefined;
  }
};

const REVIEW_DUTY_INSTRUCTIONS = [
  /^Re-scan ST0x-Technology and rainlanguage PR duty; process newly actionable own and assigned-review work under the loaded repository and review policies, then remain operational\.$/,
  /^Re-scan DataClique PR duty; process newly actionable own and assigned-review work under the loaded repository and review policies, then remain operational\.$/,
  /^Re-scan 0xgleb personal-repository PR duty; process newly actionable own and assigned-review work under the loaded repository and review policies, then remain operational\.$/,
] as const;

export const migrateReviewDutyLoopCadence: (
  state: LoopState | undefined,
  now: number,
) => ActiveLoopState | undefined = (state, now) => {
  if (
    state?.status !== "active" ||
    state.intervalMs !== LEGACY_REVIEW_DUTY_LOOP_INTERVAL_MS ||
    !REVIEW_DUTY_INSTRUCTIONS.some((pattern) => pattern.test(state.instruction))
  ) {
    return undefined;
  }
  return {
    ...state,
    intervalMs: REVIEW_DUTY_LOOP_INTERVAL_MS,
    nextRunAt: now + REVIEW_DUTY_LOOP_INTERVAL_MS,
  };
};

export const advanceLoop: (state: ActiveLoopState, now: number) => ActiveLoopState = (state, now) => {
  return {
    ...state,
    nextRunAt: now + state.intervalMs,
    runs: state.runs + 1,
    lastRunAt: now,
  };
};

export const loopDispatch: (state: ActiveLoopState) => LoopDispatch = (state) => {
  return /^\/reload(?:\s|$)/i.test(state.instruction.trim())
    ? { kind: "command", text: "/reload-runtime" }
    : {
        kind: "prompt",
        text: `Recurring loop run #${state.runs} (infinite):\n${state.instruction}`,
      };
};

export const formatLoopStatus: (state: LoopState | undefined, now: number) => string = (state, now) => {
  if (!state) return "No recurring loop has been set in this session.";
  const cadence = formatDuration(state.intervalMs);
  const next = state.status === "active" ? `next ${formatUntil(state.nextRunAt - now)}` : "stopped";
  return [
    `Loop (${state.status}, infinite): every ${cadence} · ${next} · ${state.runs} runs`,
    state.instruction,
  ].join("\n");
};

const parseInterval: (amount: number, unit: string) => number = (amount, unit) => {
  const multiplier = INTERVAL_MULTIPLIERS[unit];
  if (multiplier === undefined) throw new Error("Loop interval unit must be s, m, h, or d.");
  const intervalMs = amount * multiplier;
  if (!Number.isSafeInteger(intervalMs) || intervalMs < MIN_LOOP_INTERVAL_MS) {
    throw new Error("Loop intervals must be at least 1 minute.");
  }
  if (intervalMs > MAX_LOOP_INTERVAL_MS) throw new Error("Loop intervals may be at most 7 days.");
  return intervalMs;
};

const formatUntil: (milliseconds: number) => string = (milliseconds) =>
  milliseconds <= 0 ? "due now" : `in ${formatDuration(milliseconds)}`;

const formatDuration: (milliseconds: number) => string = (milliseconds) => {
  const minutes = Math.max(1, Math.ceil(milliseconds / 60_000));
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 1_440) {
    const hours = Math.floor(minutes / 60);
    const remainder = minutes % 60;
    return remainder === 0 ? `${hours}h` : `${hours}h ${remainder}m`;
  }
  const days = Math.floor(minutes / 1_440);
  const hours = Math.floor((minutes % 1_440) / 60);
  return hours === 0 ? `${days}d` : `${days}d ${hours}h`;
};

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isNonNegativeInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0;

const isTimestamp = (value: unknown): value is number => isNonNegativeInteger(value);

const isValidInterval = (value: unknown): value is number =>
  isNonNegativeInteger(value) && value >= MIN_LOOP_INTERVAL_MS && value <= MAX_LOOP_INTERVAL_MS;
