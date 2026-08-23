import assert from "node:assert/strict"
import test from "node:test"
import {
  selectedAllowanceCheckpoints,
  type ProviderAllowanceCheckpoint,
} from "./allowance-pool.ts"

test("controller-selected manual Codex aggregate excludes newer account samples", () => {
  const checkpoints: readonly ProviderAllowanceCheckpoint[] = [
    {
      provider: "openai",
      pool: "codex-app-server-weekly",
      source: "manual",
      capturedAt: 1_787_242_996_918,
      remainingPercent: 113,
      resetAt: 1_787_535_900_000,
    },
    {
      provider: "openai",
      pool: "codex-app-server-weekly",
      source: "codex-app-server",
      capturedAt: 1_787_247_626_086,
      remainingPercent: 100,
      resetAt: 1_787_834_181_000,
    },
    {
      provider: "openai",
      pool: "chatgpt-shared-weekly",
      source: "manual",
      capturedAt: 1_787_242_996_918,
      remainingPercent: 113,
      resetAt: 1_787_535_900_000,
    },
  ]

  assert.deepEqual(
    selectedAllowanceCheckpoints(checkpoints, {
      provider: "openai",
      pool: "codex-app-server-weekly",
      source: "manual",
    }),
    [checkpoints[0]],
  )
})
