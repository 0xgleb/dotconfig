import { spawn } from "node:child_process"
import { Data, Effect } from "effect"
import type { ProviderAllowanceCheckpoint } from "./allowance-pool.ts"

export const MAX_CODEX_APP_SERVER_OUTPUT_BYTES = 256 * 1_024
const MAX_RATE_LIMIT_WINDOW_MINUTES = 31 * 24 * 60
const MAX_RATE_LIMIT_RESET_AHEAD_MS = 31 * 24 * 60 * 60 * 1_000

export class CodexAllowanceError extends Data.TaggedError(
  "CodexAllowanceError",
)<{
  readonly code:
    | "invalid_output"
    | "missing_weekly_window"
    | "process_failed"
    | "timeout"
  readonly message: string
}> {}

const error = (
  code: CodexAllowanceError["code"],
  message: string,
): CodexAllowanceError => new CodexAllowanceError({ code, message })

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

interface RateLimitWindow {
  readonly usedPercent: number
  readonly resetsAt: number
  readonly windowDurationMins: number
}

const decodeWindow = (
  value: unknown,
  capturedAt: number,
): RateLimitWindow | undefined => {
  if (!isRecord(value)) return undefined
  const usedPercent = value.usedPercent
  const resetsAtSeconds = value.resetsAt
  const windowDurationMins = value.windowDurationMins
  if (
    typeof usedPercent !== "number" ||
    !Number.isSafeInteger(usedPercent) ||
    usedPercent < 0 ||
    usedPercent > 100 ||
    typeof resetsAtSeconds !== "number" ||
    !Number.isSafeInteger(resetsAtSeconds) ||
    resetsAtSeconds <= 0 ||
    typeof windowDurationMins !== "number" ||
    !Number.isSafeInteger(windowDurationMins) ||
    windowDurationMins <= 0 ||
    windowDurationMins > MAX_RATE_LIMIT_WINDOW_MINUTES
  )
    return undefined
  const resetsAt = resetsAtSeconds * 1_000
  if (
    !Number.isSafeInteger(resetsAt) ||
    resetsAt <= capturedAt ||
    resetsAt - capturedAt > MAX_RATE_LIMIT_RESET_AHEAD_MS
  )
    return undefined
  return { usedPercent, resetsAt, windowDurationMins }
}

const rateLimitSnapshot = (
  result: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> | undefined => {
  const byLimit = result.rateLimitsByLimitId
  if (isRecord(byLimit) && isRecord(byLimit.codex)) return byLimit.codex
  return isRecord(result.rateLimits) ? result.rateLimits : undefined
}

const APP_SERVER_TIMEOUT_MS = 10_000
const APP_SERVER_INITIALIZE = `${JSON.stringify({
  id: 1,
  method: "initialize",
  params: { clientInfo: { name: "pi-control-plane", version: "1" } },
})}\n`
const APP_SERVER_RATE_LIMIT_READ =
  [
    { method: "initialized" },
    { id: 2, method: "account/rateLimits/read", params: null },
  ]
    .map(request => JSON.stringify(request))
    .join("\n") + "\n"

export const decodeCodexWeeklyAllowance = (
  output: string,
  capturedAt: number,
): Effect.Effect<ProviderAllowanceCheckpoint, CodexAllowanceError> =>
  Effect.gen(function* () {
    if (
      !Number.isSafeInteger(capturedAt) ||
      capturedAt < 0 ||
      Buffer.byteLength(output) > MAX_CODEX_APP_SERVER_OUTPUT_BYTES
    )
      return yield* Effect.fail(
        error(
          "invalid_output",
          "Codex rate-limit output is malformed or oversized",
        ),
      )

    const lines = output.split("\n").filter(line => line.trim().length > 0)
    const responses = yield* Effect.forEach(lines, line =>
      Effect.try({
        try: () => JSON.parse(line) as unknown,
        catch: () =>
          error("invalid_output", "Codex rate-limit output is not JSONL"),
      }),
    )
    const response = responses.find(
      value => isRecord(value) && value.id === 2 && isRecord(value.result),
    )
    if (!isRecord(response) || !isRecord(response.result)) {
      const shape = responses
        .slice(0, 8)
        .map(value =>
          isRecord(value)
            ? `${String(value.id ?? "notification")}:${Object.keys(value).sort().join(",")}`
            : typeof value,
        )
        .join(";")
      return yield* Effect.fail(
        error(
          "invalid_output",
          `Codex rate-limit response is missing (${shape})`,
        ),
      )
    }
    const snapshot = rateLimitSnapshot(response.result)
    if (!snapshot)
      return yield* Effect.fail(
        error("missing_weekly_window", "Codex rate-limit snapshot is missing"),
      )
    const windows = [snapshot.primary, snapshot.secondary]
      .flatMap(value => {
        const decoded = decodeWindow(value, capturedAt)
        return decoded ? [decoded] : []
      })
      .sort((left, right) => right.windowDurationMins - left.windowDurationMins)
    const weekly = windows[0]
    if (!weekly)
      return yield* Effect.fail(
        error(
          "missing_weekly_window",
          "Codex weekly rate-limit window is unavailable",
        ),
      )
    return {
      provider: "openai",
      pool: "codex-app-server-weekly",
      source: "codex-app-server",
      capturedAt,
      remainingPercent: 100 - weekly.usedPercent,
      resetAt: weekly.resetsAt,
    }
  })

export const sampleCodexWeeklyAllowance = (
  executable: string,
  capturedAt: number,
): Effect.Effect<ProviderAllowanceCheckpoint, CodexAllowanceError> =>
  Effect.async(resume => {
    if (
      executable.length < 1 ||
      executable.length > 1_024 ||
      !Number.isSafeInteger(capturedAt) ||
      capturedAt < 0
    ) {
      resume(
        Effect.fail(error("process_failed", "Codex sampler input is invalid")),
      )
      return
    }
    const child = spawn(executable, ["app-server", "--stdio"], {
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    })
    const stdout: Buffer[] = []
    let outputBytes = 0
    let lineBuffer = ""
    let initialized = false
    let settled = false
    const finish = (
      result: Effect.Effect<ProviderAllowanceCheckpoint, CodexAllowanceError>,
    ): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resume(result)
    }
    const timer = setTimeout(() => {
      child.kill("SIGTERM")
      finish(
        Effect.fail(error("timeout", "Codex app-server sampler timed out")),
      )
    }, APP_SERVER_TIMEOUT_MS)
    timer.unref?.()
    child.stdout.on("data", (chunk: Buffer) => {
      outputBytes += chunk.length
      if (outputBytes > MAX_CODEX_APP_SERVER_OUTPUT_BYTES) {
        child.kill("SIGTERM")
        finish(
          Effect.fail(
            error(
              "invalid_output",
              "Codex app-server output exceeded its bound",
            ),
          ),
        )
        return
      }
      stdout.push(chunk)
      lineBuffer += chunk.toString("utf8")
      const lines = lineBuffer.split("\n")
      lineBuffer = lines.pop() ?? ""
      for (const line of lines) {
        let message: unknown
        try {
          message = JSON.parse(line)
        } catch {
          child.kill("SIGTERM")
          finish(
            Effect.fail(
              error("invalid_output", "Codex app-server emitted invalid JSONL"),
            ),
          )
          return
        }
        if (!isRecord(message)) continue
        if (message.id === 1 && isRecord(message.result) && !initialized) {
          initialized = true
          child.stdin.write(APP_SERVER_RATE_LIMIT_READ)
        }
        if (message.id === 2 && isRecord(message.result)) {
          child.kill("SIGTERM")
          finish(
            decodeCodexWeeklyAllowance(
              Buffer.concat(stdout).toString("utf8"),
              capturedAt,
            ),
          )
          return
        }
      }
    })
    let stderrBytes = 0
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.length
      if (stderrBytes > MAX_CODEX_APP_SERVER_OUTPUT_BYTES) {
        child.kill("SIGTERM")
        finish(
          Effect.fail(
            error(
              "invalid_output",
              "Codex app-server diagnostics exceeded their bound",
            ),
          ),
        )
      }
    })
    child.once("error", () =>
      finish(
        Effect.fail(
          error("process_failed", "Codex app-server failed to start"),
        ),
      ),
    )
    child.once("close", code => {
      if (settled) return
      if (code !== 0) {
        finish(
          Effect.fail(
            error("process_failed", "Codex app-server exited unsuccessfully"),
          ),
        )
        return
      }
      finish(
        decodeCodexWeeklyAllowance(
          Buffer.concat(stdout).toString("utf8"),
          capturedAt,
        ),
      )
    })
    child.stdin.write(APP_SERVER_INITIALIZE)
    return Effect.sync(() => {
      if (!settled) child.kill("SIGTERM")
      clearTimeout(timer)
    })
  })
