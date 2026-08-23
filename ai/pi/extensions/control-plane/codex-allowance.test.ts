import assert from "node:assert/strict"
import test from "node:test"
import { Effect, Either } from "effect"

import {
  decodeCodexWeeklyAllowance,
  MAX_CODEX_APP_SERVER_OUTPUT_BYTES,
} from "./codex-allowance.ts"

const capturedAt = 1_786_475_520_000
const weeklyResetSeconds = 1_787_011_320

const responseLine = (result: unknown): string =>
  JSON.stringify({ id: 2, result })

test("Codex app-server decoder selects the longest official rate-limit window", () => {
  const output = responseLine({
    rateLimits: {
      limitId: "codex",
      primary: {
        usedPercent: 27,
        resetsAt: 1_786_477_680,
        windowDurationMins: 300,
      },
      secondary: {
        usedPercent: 62,
        resetsAt: weeklyResetSeconds,
        windowDurationMins: 10_080,
      },
    },
    rateLimitsByLimitId: null,
  })

  assert.deepEqual(
    Effect.runSync(decodeCodexWeeklyAllowance(output, capturedAt)),
    {
      provider: "openai",
      pool: "codex-app-server-weekly",
      source: "codex-app-server",
      capturedAt,
      remainingPercent: 38,
      resetAt: weeklyResetSeconds * 1_000,
    },
  )
})

test("Codex app-server decoder prefers the explicit codex bucket", () => {
  const output = responseLine({
    rateLimits: {
      secondary: {
        usedPercent: 99,
        resetsAt: weeklyResetSeconds,
        windowDurationMins: 10_080,
      },
    },
    rateLimitsByLimitId: {
      other: {
        secondary: {
          usedPercent: 90,
          resetsAt: weeklyResetSeconds,
          windowDurationMins: 10_080,
        },
      },
      codex: {
        secondary: {
          usedPercent: 62,
          resetsAt: weeklyResetSeconds,
          windowDurationMins: 10_080,
        },
      },
    },
  })

  assert.equal(
    Effect.runSync(decodeCodexWeeklyAllowance(output, capturedAt))
      .remainingPercent,
    38,
  )
})

test("Codex app-server decoder fails closed on malformed or oversized output", () => {
  const malformed = responseLine({
    rateLimits: {
      secondary: {
        usedPercent: 101,
        resetsAt: weeklyResetSeconds,
        windowDurationMins: 10_080,
      },
    },
  })
  assert.equal(
    Either.isLeft(
      Effect.runSync(
        Effect.either(decodeCodexWeeklyAllowance(malformed, capturedAt)),
      ),
    ),
    true,
  )

  const oversized = "x".repeat(MAX_CODEX_APP_SERVER_OUTPUT_BYTES + 1)
  assert.equal(
    Either.isLeft(
      Effect.runSync(
        Effect.either(decodeCodexWeeklyAllowance(oversized, capturedAt)),
      ),
    ),
    true,
  )
})
