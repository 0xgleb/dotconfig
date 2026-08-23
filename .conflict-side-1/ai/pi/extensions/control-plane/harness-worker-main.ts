import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { Data, Effect, Either } from "effect"
import {
  runNextHarnessAttempt,
  spawnHarnessExecutor,
  type HarnessAttemptOutcome,
  type HarnessWorkerError,
} from "./harness-worker.ts"

export interface HarnessWorkerConfig {
  readonly origin: string
  readonly workerId: string
  readonly pollIntervalMs: number
  readonly leaseTtlMs: number
  readonly retryDelayMs: number
  readonly executorTimeoutMs: number
  readonly allowedRoots: readonly string[]
}

export interface HarnessWorkerLoopOptions {
  readonly runAttempt: Effect.Effect<HarnessAttemptOutcome, HarnessWorkerError>
  readonly pollIntervalMs: number
  readonly shouldStop: () => boolean
  readonly sleep: (delayMs: number) => Effect.Effect<void>
  readonly log: (line: string) => void
}

export class HarnessWorkerConfigError extends Data.TaggedError(
  "HarnessWorkerConfigError",
)<{
  readonly code: "invalid_config"
  readonly message: string
}> {}

const configError = (message: string): HarnessWorkerConfigError =>
  new HarnessWorkerConfigError({ code: "invalid_config", message })

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const SAFE_WORKER_ID = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,63}$/u

const boundedEnvironmentInteger = (
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number,
): number | undefined => {
  if (value === undefined) return fallback
  if (typeof value !== "string" || !/^\d+$/u.test(value)) return undefined
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum
    ? parsed
    : undefined
}

export const parseHarnessWorkerConfig = (
  environment: unknown,
): Effect.Effect<HarnessWorkerConfig, HarnessWorkerConfigError> => {
  if (!isRecord(environment))
    return Effect.fail(configError("environment must be an object"))
  const port = boundedEnvironmentInteger(
    environment.PI_CONTROL_PLANE_PORT,
    43_121,
    1,
    65_535,
  )
  if (port === undefined) {
    return Effect.fail(
      configError("PI_CONTROL_PLANE_PORT must be an integer from 1 to 65535"),
    )
  }
  const workerId =
    environment.PI_HARNESS_WORKER_ID === undefined
      ? "harness-worker"
      : environment.PI_HARNESS_WORKER_ID
  if (typeof workerId !== "string" || !SAFE_WORKER_ID.test(workerId)) {
    return Effect.fail(
      configError("PI_HARNESS_WORKER_ID must be a bounded safe identifier"),
    )
  }
  const pollIntervalMs = boundedEnvironmentInteger(
    environment.PI_HARNESS_POLL_MS,
    30_000,
    1_000,
    3_600_000,
  )
  if (pollIntervalMs === undefined) {
    return Effect.fail(
      configError("PI_HARNESS_POLL_MS must be from one second to one hour"),
    )
  }
  const executorTimeoutMs = boundedEnvironmentInteger(
    environment.PI_HARNESS_EXECUTOR_TIMEOUT_MS,
    2_400_000,
    10_000,
    21_600_000,
  )
  if (executorTimeoutMs === undefined) {
    return Effect.fail(
      configError(
        "PI_HARNESS_EXECUTOR_TIMEOUT_MS must be from ten seconds to six hours",
      ),
    )
  }
  const leaseTtlMs = boundedEnvironmentInteger(
    environment.PI_HARNESS_LEASE_TTL_MS,
    2_700_000,
    1,
    86_400_000,
  )
  if (leaseTtlMs === undefined || leaseTtlMs <= executorTimeoutMs) {
    return Effect.fail(
      configError(
        "PI_HARNESS_LEASE_TTL_MS must exceed the executor timeout and stay within one day",
      ),
    )
  }
  const retryDelayMs = boundedEnvironmentInteger(
    environment.PI_HARNESS_RETRY_DELAY_MS,
    900_000,
    0,
    604_800_000,
  )
  if (retryDelayMs === undefined) {
    return Effect.fail(
      configError("PI_HARNESS_RETRY_DELAY_MS must be from zero to seven days"),
    )
  }
  const configuredRoots = environment.PI_HARNESS_ALLOWED_ROOTS
  const allowedRoots =
    typeof configuredRoots === "string" && configuredRoots.length > 0
      ? configuredRoots.split(":")
      : []
  if (
    allowedRoots.length < 1 ||
    allowedRoots.length > 16 ||
    !allowedRoots.every(
      root => root.startsWith("/") && root.length > 1 && root.length <= 1_024,
    )
  ) {
    return Effect.fail(
      configError(
        "PI_HARNESS_ALLOWED_ROOTS must be a colon-separated list of absolute workspace roots",
      ),
    )
  }
  return Effect.succeed({
    origin: `http://127.0.0.1:${String(port)}`,
    workerId,
    pollIntervalMs,
    leaseTtlMs,
    retryDelayMs,
    executorTimeoutMs,
    allowedRoots,
  })
}

export const nextHarnessDelayMs = (
  outcome: HarnessAttemptOutcome,
  pollIntervalMs: number,
): number =>
  outcome.outcome === "completed" || outcome.outcome === "failed"
    ? 1_000
    : pollIntervalMs

const MAX_LOG_DETAIL_LENGTH = 300
const LOG_UNSAFE_CHARACTERS = new RegExp("[\\u0000-\\u001f\\u007f]+", "gu")

const sanitizedDetail = (detail: string): string =>
  detail.replace(LOG_UNSAFE_CHARACTERS, " ").slice(0, MAX_LOG_DETAIL_LENGTH)

const outcomeLine = (
  outcome: Either.Either<HarnessAttemptOutcome, HarnessWorkerError>,
): string => {
  if (Either.isLeft(outcome))
    return `pi-harness-worker attempt error: ${sanitizedDetail(outcome.left.message)}`
  const value = outcome.right
  if (value.outcome === "idle") return "pi-harness-worker idle"
  if (value.outcome === "failed")
    return `pi-harness-worker ${value.jobId} failed: ${sanitizedDetail(value.reason)}`
  return `pi-harness-worker ${value.jobId} ${value.outcome}`
}

export const runHarnessWorkerLoop = (
  options: HarnessWorkerLoopOptions,
): Effect.Effect<number> =>
  Effect.gen(function* () {
    let iterations = 0
    while (!options.shouldStop()) {
      const outcome = yield* Effect.either(options.runAttempt)
      iterations += 1
      options.log(outcomeLine(outcome))
      const delayMs = Either.isLeft(outcome)
        ? options.pollIntervalMs
        : nextHarnessDelayMs(outcome.right, options.pollIntervalMs)
      yield* options.sleep(delayMs)
    }
    return iterations
  })

const isMainModule =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))

if (isMainModule) {
  let stopped = false
  let releaseSleep: (() => void) | undefined
  const stop = (): void => {
    stopped = true
    releaseSleep?.()
  }
  process.once("SIGINT", stop)
  process.once("SIGTERM", stop)
  const interruptibleSleep = (delayMs: number): Effect.Effect<void> =>
    Effect.async(resume => {
      const timer = setTimeout(() => resume(Effect.void), delayMs)
      releaseSleep = () => {
        clearTimeout(timer)
        resume(Effect.void)
      }
      return Effect.sync(() => clearTimeout(timer))
    })
  const program = Effect.flatMap(
    parseHarnessWorkerConfig(process.env),
    config =>
      runHarnessWorkerLoop({
        runAttempt: runNextHarnessAttempt({
          origin: config.origin,
          workerId: config.workerId,
          leaseTtlMs: config.leaseTtlMs,
          retryDelayMs: config.retryDelayMs,
          allowedRoots: config.allowedRoots,
          spawner: spawnHarnessExecutor(config.executorTimeoutMs),
        }),
        pollIntervalMs: config.pollIntervalMs,
        shouldStop: () => stopped,
        sleep: interruptibleSleep,
        log: line => console.log(line),
      }),
  )
  void Effect.runPromise(Effect.either(program)).then(
    result => {
      if (Either.isLeft(result)) {
        console.error(`pi-harness-worker stopped: ${result.left.message}`)
        process.exitCode = 1
      }
    },
    () => {
      console.error("pi-harness-worker stopped with an internal error")
      process.exitCode = 1
    },
  )
}
