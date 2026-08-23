import assert from "node:assert/strict"
import test from "node:test"

import {
  allowanceChartCheckpoints,
  allowanceChartDomain,
  allowanceChartSegments,
  allowanceChartX,
  reconstructChatGptSharedHistory,
} from "./allowance-chart.ts"

test("allowance chart retains history when the provider revises the reset timestamp", () => {
  const olderReset = 10_000
  const revisedReset = 20_000
  const history = [
    { capturedAt: 3_000, remainingPercent: 76, resetAt: revisedReset },
    { capturedAt: 1_000, remainingPercent: 88, resetAt: olderReset },
    { capturedAt: 2_000, remainingPercent: 81, resetAt: olderReset },
  ]

  assert.deepEqual(allowanceChartCheckpoints(history), [
    history[1],
    history[2],
    history[0],
  ])
})

test("stale allowance history keeps a usable chart domain without an active runway", () => {
  const history = [
    { capturedAt: 1_000, remainingPercent: 88, resetAt: 10_000 },
    { capturedAt: 3_000, remainingPercent: 76, resetAt: 20_000 },
  ]

  const domain = allowanceChartDomain(history)
  assert.deepEqual(domain, { startAt: 1_000, endAt: 20_000 })
  assert.equal(allowanceChartX(1_000, domain), 0)
  assert.ok(Math.abs(allowanceChartX(3_000, domain) - 200 / 19) < 1e-12)
  assert.equal(allowanceChartX(20_000, domain), 100)
})

test("allowance chart never draws continuity across a reset or allowance increase", () => {
  const history = [
    { capturedAt: 1_000, remainingPercent: 14, resetAt: 9_000 },
    { capturedAt: 2_000, remainingPercent: 0, resetAt: 9_000 },
    { capturedAt: 3_000, remainingPercent: 100, resetAt: 15_000 },
    { capturedAt: 4_000, remainingPercent: 38, resetAt: 15_000 },
  ]

  assert.deepEqual(allowanceChartSegments(history), [
    [history[0], history[1]],
    [history[2], history[3]],
  ])
})

test("ChatGPT history reconstruction shows both resets, exhaustion, and bailout without merging app-server usage", () => {
  const week = 7 * 24 * 60 * 60 * 1_000
  const firstResetAt = 2 * week
  const bailoutAt = 3 * week
  const currentResetAt = 4 * week
  const history = [
    {
      provider: "legacy" as const,
      pool: "generic" as const,
      source: "legacy-import" as const,
      capturedAt: week + 4 * 60 * 60 * 1_000,
      remainingPercent: 79,
      resetAt: firstResetAt,
    },
    {
      provider: "legacy" as const,
      pool: "generic" as const,
      source: "legacy-import" as const,
      capturedAt: week + 16 * 60 * 60 * 1_000,
      remainingPercent: 65,
      resetAt: firstResetAt,
    },
    {
      provider: "legacy" as const,
      pool: "generic" as const,
      source: "legacy-import" as const,
      capturedAt: week + 20 * 60 * 60 * 1_000,
      remainingPercent: 94,
      resetAt: firstResetAt,
    },
    {
      provider: "legacy" as const,
      pool: "generic" as const,
      source: "legacy-import" as const,
      capturedAt: bailoutAt - 4 * 60 * 60 * 1_000,
      remainingPercent: 14,
      resetAt: 3 * week + 4 * 24 * 60 * 60 * 1_000,
    },
    {
      provider: "openai" as const,
      pool: "chatgpt-shared-weekly" as const,
      source: "estimated-history" as const,
      capturedAt: bailoutAt,
      remainingPercent: 100,
      resetAt: currentResetAt,
    },
    {
      provider: "openai" as const,
      pool: "chatgpt-shared-weekly" as const,
      source: "manual" as const,
      capturedAt: bailoutAt + 20 * 60 * 60 * 1_000,
      remainingPercent: 38,
      resetAt: currentResetAt,
    },
    {
      provider: "openai" as const,
      pool: "codex-app-server-weekly" as const,
      source: "codex-app-server" as const,
      capturedAt: bailoutAt + 20 * 60 * 60 * 1_000,
      remainingPercent: 100,
      resetAt: currentResetAt,
    },
  ]

  const reconstructed = reconstructChatGptSharedHistory(history)
  assert.deepEqual(
    reconstructed.points.map(({ remainingPercent, evidence, event }) => ({
      remainingPercent,
      evidence,
      event,
    })),
    [
      { remainingPercent: 100, evidence: "estimated", event: "cycle-start" },
      { remainingPercent: 79, evidence: "observed", event: undefined },
      { remainingPercent: 65, evidence: "observed", event: undefined },
      { remainingPercent: 100, evidence: "estimated", event: "provider-reset" },
      { remainingPercent: 94, evidence: "observed", event: undefined },
      { remainingPercent: 14, evidence: "observed", event: undefined },
      { remainingPercent: 0, evidence: "estimated", event: "exhaustion" },
      { remainingPercent: 100, evidence: "estimated", event: "bailout" },
      { remainingPercent: 38, evidence: "observed", event: undefined },
    ],
  )
  assert.equal(
    reconstructed.points.some(
      ({ capturedAt, remainingPercent }) =>
        capturedAt === history.at(-1)?.capturedAt && remainingPercent === 100,
    ),
    false,
  )
  assert.deepEqual(
    allowanceChartSegments(reconstructed.points).map(segment =>
      segment.map(({ remainingPercent }) => remainingPercent),
    ),
    [
      [100, 79, 65],
      [100, 94],
      [14, 0],
      [100, 38],
    ],
  )
})
