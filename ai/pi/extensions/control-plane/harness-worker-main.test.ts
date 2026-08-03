import assert from "node:assert/strict"
import test from "node:test"
import { Effect, Either } from "effect"
import { HarnessWorkerError } from "./harness-worker.ts"
import {
  nextHarnessDelayMs,
  parseHarnessWorkerConfig,
  runHarnessWorkerLoop,
} from "./harness-worker-main.ts"

const codeOf = (value: unknown): string | undefined => {
  const result = Effect.runSync(Effect.either(parseHarnessWorkerConfig(value)))
  if (Either.isRight(result)) return undefined
  return result.left.code
}

test("harness worker config is loopback-only with bounded safe defaults", () => {
  assert.deepEqual(
    Effect.runSync(parseHarnessWorkerConfig({})),
    {
      origin: "http://127.0.0.1:43121",
      workerId: "harness-worker",
      pollIntervalMs: 30_000,
      leaseTtlMs: 2_700_000,
      retryDelayMs: 900_000,
      executorTimeoutMs: 2_400_000,
    },
  )
  assert.deepEqual(
    Effect.runSync(
      parseHarnessWorkerConfig({
        PI_CONTROL_PLANE_PORT: "43999",
        PI_HARNESS_WORKER_ID: "harness-supervisor.local",
        PI_HARNESS_POLL_MS: "5000",
        PI_HARNESS_LEASE_TTL_MS: "600000",
        PI_HARNESS_RETRY_DELAY_MS: "0",
        PI_HARNESS_EXECUTOR_TIMEOUT_MS: "120000",
      }),
    ),
    {
      origin: "http://127.0.0.1:43999",
      workerId: "harness-supervisor.local",
      pollIntervalMs: 5_000,
      leaseTtlMs: 600_000,
      retryDelayMs: 0,
      executorTimeoutMs: 120_000,
    },
  )
})

test("harness worker config rejects malformed or unsafe environment values", () => {
  assert.equal(codeOf(undefined), "invalid_config")
  assert.equal(codeOf({ PI_CONTROL_PLANE_PORT: "0" }), "invalid_config")
  assert.equal(codeOf({ PI_CONTROL_PLANE_PORT: "70000" }), "invalid_config")
  assert.equal(codeOf({ PI_HARNESS_WORKER_ID: "bad worker id" }), "invalid_config")
  assert.equal(codeOf({ PI_HARNESS_WORKER_ID: "" }), "invalid_config")
  assert.equal(codeOf({ PI_HARNESS_POLL_MS: "999" }), "invalid_config")
  assert.equal(codeOf({ PI_HARNESS_POLL_MS: "3600001" }), "invalid_config")
  assert.equal(codeOf({ PI_HARNESS_POLL_MS: "not-a-number" }), "invalid_config")
  assert.equal(codeOf({ PI_HARNESS_RETRY_DELAY_MS: "-1" }), "invalid_config")
  assert.equal(
    codeOf({ PI_HARNESS_EXECUTOR_TIMEOUT_MS: "9999" }),
    "invalid_config",
  )
  assert.equal(codeOf({ PI_HARNESS_LEASE_TTL_MS: "86400001" }), "invalid_config")
  assert.equal(
    codeOf({
      PI_HARNESS_LEASE_TTL_MS: "120000",
      PI_HARNESS_EXECUTOR_TIMEOUT_MS: "120000",
    }),
    "invalid_config",
  )
})

test("attempt outcomes drain quickly while idle polls at the configured cadence", () => {
  assert.equal(nextHarnessDelayMs({ outcome: "idle" }, 30_000), 30_000)
  assert.equal(
    nextHarnessDelayMs({ outcome: "unsupported", jobId: "job-a" }, 30_000),
    30_000,
  )
  assert.equal(
    nextHarnessDelayMs({ outcome: "completed", jobId: "job-a" }, 30_000),
    1_000,
  )
  assert.equal(
    nextHarnessDelayMs(
      { outcome: "failed", jobId: "job-a", reason: "executor exited" },
      30_000,
    ),
    1_000,
  )
})

test("the worker loop survives attempt errors and stops on shutdown", async () => {
  const outcomes = [
    Effect.succeed({
      outcome: "failed",
      jobId: "job-a",
      reason: "executor exited\nforged: second log line",
    } as const),
    Effect.fail(
      new HarnessWorkerError({
        code: "request_failed",
        message: "control plane\nrestarting",
      }),
    ),
    Effect.succeed({ outcome: "idle" } as const),
  ]
  const delays: number[] = []
  const lines: string[] = []
  let iteration = 0
  const iterations = await Effect.runPromise(
    runHarnessWorkerLoop({
      runAttempt: Effect.suspend(
        () => outcomes[iteration] ?? Effect.succeed({ outcome: "idle" } as const),
      ),
      pollIntervalMs: 30_000,
      shouldStop: () => iteration >= 3,
      sleep: (delayMs) =>
        Effect.sync(() => {
          delays.push(delayMs)
          iteration += 1
        }),
      log: (line) => lines.push(line),
    }),
  )
  assert.equal(iterations, 3)
  assert.deepEqual(delays, [1_000, 30_000, 30_000])
  assert.equal(lines.length, 3)
  assert.equal(lines.every((line) => !line.includes("\n")), true)
  assert.equal(lines[0]?.includes("executor exited forged: second log line"), true)
  assert.equal(lines[1]?.includes("control plane restarting"), true)
})
