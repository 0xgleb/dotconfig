import { randomInt } from "node:crypto"
import { Data, Effect } from "effect"

export interface ActiveLoopState {
  readonly status: "active"
  readonly instruction: string
  readonly intervalMs: number
  readonly jitterMs?: number
  readonly startedAt: number
  readonly nextRunAt: number
  readonly runs: number
  readonly lastRunAt?: number
}

export interface ClearedLoopState {
  readonly status: "cleared"
  readonly instruction: string
  readonly intervalMs: number
  readonly jitterMs?: number
  readonly startedAt: number
  readonly nextRunAt: number
  readonly runs: number
  readonly finishedAt: number
  readonly lastRunAt?: number
}

export type LoopState = ActiveLoopState | ClearedLoopState

export type LoopCommand =
  | { readonly action: "status" }
  | { readonly action: "clear" }
  | {
      readonly action: "set"
      readonly instruction: string
      readonly intervalMs: number
      readonly jitterMs?: number
    }

export type LoopDispatch =
  | { readonly kind: "command"; readonly text: "/reload-runtime" }
  | { readonly kind: "prompt"; readonly text: string }

export const DEFAULT_LOOP_INTERVAL_MS = 60 * 60 * 1_000
export const REVIEW_DUTY_LOOP_INTERVAL_MS = 2 * 60 * 60 * 1_000
export const REVIEW_DUTY_LOOP_JITTER_MS = 60 * 60 * 1_000
const LEGACY_REVIEW_DUTY_LOOP_INTERVAL_MS = 15 * 60 * 1_000
const MIN_LOOP_INTERVAL_MS = 60 * 1_000
const MAX_LOOP_INTERVAL_MS = 7 * 24 * 60 * 60 * 1_000
const MAX_INSTRUCTION_LENGTH = 4_000
const INTERVAL_MULTIPLIERS: Readonly<Record<string, number>> = {
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
}

export class LoopCommandError extends Data.TaggedError("LoopCommandError")<{
  readonly message: string
}> {}

const loopFailure = (message: string): LoopCommandError =>
  new LoopCommandError({ message })

export type LoopCommandResult =
  | { readonly ok: true; readonly value: LoopCommand }
  | { readonly ok: false; readonly error: LoopCommandError }

const parseIntervalResult = (
  amount: number,
  unit: string,
):
  | { readonly ok: true; readonly value: number }
  | {
      readonly ok: false
      readonly error: LoopCommandError
    } => {
  const multiplier = INTERVAL_MULTIPLIERS[unit]
  if (multiplier === undefined)
    return {
      ok: false,
      error: loopFailure("Loop interval unit must be s, m, h, or d."),
    }
  const intervalMs = amount * multiplier
  if (!Number.isSafeInteger(intervalMs) || intervalMs < MIN_LOOP_INTERVAL_MS)
    return {
      ok: false,
      error: loopFailure("Loop intervals must be at least 1 minute."),
    }
  return intervalMs > MAX_LOOP_INTERVAL_MS
    ? {
        ok: false,
        error: loopFailure("Loop intervals may be at most 7 days."),
      }
    : { ok: true, value: intervalMs }
}

export const parseLoopCommandResult = (args: string): LoopCommandResult => {
  const input = args.trim()
  if (input.length === 0 || input.toLowerCase() === "status")
    return { ok: true, value: { action: "status" } }
  if (input.toLowerCase() === "clear")
    return { ok: true, value: { action: "clear" } }
  const match = /^(\d+)([smhd])(?:\+-(\d+)([smhd]))?\s+(.+)$/i.exec(input)
  const interval = match
    ? parseIntervalResult(Number(match[1]), match[2]?.toLowerCase() ?? "")
    : { ok: true as const, value: DEFAULT_LOOP_INTERVAL_MS }
  if (!interval.ok) return interval
  const jitter = match?.[3]
    ? parseIntervalResult(Number(match[3]), match[4]?.toLowerCase() ?? "")
    : { ok: true as const, value: undefined }
  if (!jitter.ok) return jitter
  if (jitter.value !== undefined && jitter.value >= interval.value)
    return {
      ok: false,
      error: loopFailure("Loop jitter must be smaller than the base interval."),
    }
  const instruction = (match?.[5] ?? input).trim()
  if (instruction.length === 0)
    return {
      ok: false,
      error: loopFailure("Loop instructions must not be empty."),
    }
  if (instruction.length > MAX_INSTRUCTION_LENGTH)
    return {
      ok: false,
      error: loopFailure(
        "Loop instructions may contain at most 4,000 characters.",
      ),
    }
  return {
    ok: true,
    value: {
      action: "set",
      instruction,
      intervalMs: interval.value,
      ...(jitter.value !== undefined ? { jitterMs: jitter.value } : {}),
    },
  }
}

export const parseLoopCommand = (
  args: string,
): Effect.Effect<LoopCommand, LoopCommandError> => {
  const result = parseLoopCommandResult(args)
  return result.ok ? Effect.succeed(result.value) : Effect.fail(result.error)
}

export const parseStoredLoop: (
  value: unknown,
) => LoopState | undefined = value => {
  if (
    !isRecord(value) ||
    typeof value.instruction !== "string" ||
    value.instruction.length === 0 ||
    value.instruction.length > MAX_INSTRUCTION_LENGTH ||
    !isTimestamp(value.startedAt) ||
    !isTimestamp(value.nextRunAt) ||
    !isNonNegativeInteger(value.runs) ||
    !isValidInterval(value.intervalMs) ||
    (value.jitterMs !== undefined &&
      (!isValidJitter(value.jitterMs) || value.jitterMs >= value.intervalMs)) ||
    (value.lastRunAt !== undefined && !isTimestamp(value.lastRunAt))
  ) {
    return undefined
  }

  const shared = {
    instruction: value.instruction,
    intervalMs: value.intervalMs,
    ...(value.jitterMs !== undefined ? { jitterMs: value.jitterMs } : {}),
    startedAt: value.startedAt,
    nextRunAt: value.nextRunAt,
    runs: value.runs,
    ...(value.lastRunAt !== undefined ? { lastRunAt: value.lastRunAt } : {}),
  }
  if (value.status === "active") return { status: "active", ...shared }
  if (value.status === "cleared" && isTimestamp(value.finishedAt)) {
    return { status: "cleared", ...shared, finishedAt: value.finishedAt }
  }
  return undefined
}

export const migrateLegacyReloadLoop: (
  condition: string,
  now: number,
) => ActiveLoopState | undefined = (condition, now) => {
  if (!/^\d+[smhd]\s+\/reload(?:\s|$)/i.test(condition.trim())) return undefined
  const parsed = parseLoopCommandResult(condition)
  if (!parsed.ok || parsed.value.action !== "set") return undefined
  return {
    status: "active",
    instruction: parsed.value.instruction,
    intervalMs: DEFAULT_LOOP_INTERVAL_MS,
    startedAt: now,
    nextRunAt: now + DEFAULT_LOOP_INTERVAL_MS,
    runs: 0,
  }
}

const REVIEW_DUTY_INSTRUCTIONS = [
  /^Re-scan ST0x-Technology and rainlanguage PR duty; process newly actionable own and assigned-review work under the loaded repository and review policies, then remain operational\.$/,
  /^Re-scan DataClique PR duty; process newly actionable own and assigned-review work under the loaded repository and review policies, then remain operational\.$/,
  /^Re-scan 0xgleb personal-repository PR duty; process newly actionable own and assigned-review work under the loaded repository and review policies, then remain operational\.$/,
] as const

const sampledJitter = (jitterMs: number | undefined): number =>
  jitterMs === undefined ? 0 : randomInt(-jitterMs, jitterMs + 1)

export const nextLoopRunAt = (
  state: Pick<ActiveLoopState, "intervalMs" | "jitterMs">,
  now: number,
  jitterOffsetMs = sampledJitter(state.jitterMs),
): Effect.Effect<number, LoopCommandError> => {
  const jitter = state.jitterMs ?? 0
  return !Number.isSafeInteger(jitterOffsetMs) ||
    Math.abs(jitterOffsetMs) > jitter
    ? Effect.fail(
        loopFailure("Loop jitter offset is outside the configured bound."),
      )
    : Effect.succeed(now + state.intervalMs + jitterOffsetMs)
}

export const migrateReviewDutyLoopCadence = (
  state: LoopState | undefined,
  now: number,
  jitterOffsetMs?: number,
): Effect.Effect<ActiveLoopState | undefined, LoopCommandError> =>
  Effect.gen(function* () {
    if (
      state?.status !== "active" ||
      (state.intervalMs !== LEGACY_REVIEW_DUTY_LOOP_INTERVAL_MS &&
        state.intervalMs !== REVIEW_DUTY_LOOP_INTERVAL_MS) ||
      state.jitterMs === REVIEW_DUTY_LOOP_JITTER_MS ||
      !REVIEW_DUTY_INSTRUCTIONS.some(pattern => pattern.test(state.instruction))
    )
      return undefined
    const migrated = {
      ...state,
      intervalMs: REVIEW_DUTY_LOOP_INTERVAL_MS,
      jitterMs: REVIEW_DUTY_LOOP_JITTER_MS,
    }
    return {
      ...migrated,
      nextRunAt: yield* nextLoopRunAt(migrated, now, jitterOffsetMs),
    }
  })

export const advanceLoop = (
  state: ActiveLoopState,
  now: number,
  jitterOffsetMs?: number,
): Effect.Effect<ActiveLoopState, LoopCommandError> =>
  Effect.map(nextLoopRunAt(state, now, jitterOffsetMs), nextRunAt => ({
    ...state,
    nextRunAt,
    runs: state.runs + 1,
    lastRunAt: now,
  }))

export const loopDispatch: (state: ActiveLoopState) => LoopDispatch = state => {
  return /^\/reload(?:\s|$)/i.test(state.instruction.trim())
    ? { kind: "command", text: "/reload-runtime" }
    : {
        kind: "prompt",
        text: `Recurring loop run #${state.runs} (infinite):\n${state.instruction}`,
      }
}

export const formatLoopStatus: (
  state: LoopState | undefined,
  now: number,
) => string = (state, now) => {
  if (!state) return "No recurring loop has been set in this session."
  const cadence = `${formatDuration(state.intervalMs)}${
    state.jitterMs === undefined ? "" : ` ± ${formatDuration(state.jitterMs)}`
  }`
  const next =
    state.status === "active"
      ? `next ${formatUntil(state.nextRunAt - now)}`
      : "stopped"
  return [
    `Loop (${state.status}, infinite): every ${cadence} · ${next} · ${state.runs} runs`,
    state.instruction,
  ].join("\n")
}

const formatUntil: (milliseconds: number) => string = milliseconds =>
  milliseconds <= 0 ? "due now" : `in ${formatDuration(milliseconds)}`

const formatDuration: (milliseconds: number) => string = milliseconds => {
  const minutes = Math.max(1, Math.ceil(milliseconds / 60_000))
  if (minutes < 60) return `${minutes}m`
  if (minutes < 1_440) {
    const hours = Math.floor(minutes / 60)
    const remainder = minutes % 60
    return remainder === 0 ? `${hours}h` : `${hours}h ${remainder}m`
  }
  const days = Math.floor(minutes / 1_440)
  const hours = Math.floor((minutes % 1_440) / 60)
  return hours === 0 ? `${days}d` : `${days}d ${hours}h`
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const isNonNegativeInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0

const isTimestamp = (value: unknown): value is number =>
  isNonNegativeInteger(value)

const isValidInterval = (value: unknown): value is number =>
  isNonNegativeInteger(value) &&
  value >= MIN_LOOP_INTERVAL_MS &&
  value <= MAX_LOOP_INTERVAL_MS

const isValidJitter = (value: unknown): value is number =>
  isNonNegativeInteger(value) &&
  value >= MIN_LOOP_INTERVAL_MS &&
  value <= MAX_LOOP_INTERVAL_MS
