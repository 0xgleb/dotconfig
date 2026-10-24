import assert from "node:assert/strict"
import test from "node:test"
import {
  agentAllocation,
  applyInteractionPacing,
  allowanceRunway,
  effectiveThrottleRatio,
  providerTokenPolicy,
  rolePollingPolicy,
  usagePolicy,
  WEEK_MS,
  workflowTokenBudget,
} from "./usage-policy.ts"

const checkpoint = (remainingPercent: number) => ({
  capturedAt: 1_000,
  remainingPercent,
  resetAt: 1_000 + WEEK_MS,
})

test("recent owner activity temporarily restores provider throughput", () => {
  const now = 8 * 60 * 60 * 1_000
  const sustainableRatio = 0.25

  assert.equal(effectiveThrottleRatio(sustainableRatio, undefined, now), 0.25)
  assert.equal(effectiveThrottleRatio(sustainableRatio, now, now), 1)
  assert.equal(
    effectiveThrottleRatio(sustainableRatio, now - 2 * 60 * 60 * 1_000, now),
    0.625,
  )
  assert.equal(
    applyInteractionPacing(60 * 60 * 1_000, sustainableRatio, 1),
    15 * 60 * 1_000,
  )
  assert.equal(applyInteractionPacing(0, 1, 1), 0)
})

test("combined account capacity accepts allowance above one account", () => {
  assert.equal(
    allowanceRunway([checkpoint(113)], 1_000)?.latest.remainingPercent,
    113,
  )
  assert.equal(allowanceRunway([checkpoint(201)], 1_000), undefined)
  assert.deepEqual(usagePolicy([checkpoint(113)], 1_000), {
    pace: "unverified",
    minimumIntervalMs: 60 * 60 * 1_000,
    throttleRatio: 0.25,
    actualRemainingPercent: 113,
    resetAt: 1_000 + WEEK_MS,
    targetRemainingPercent: 113,
    runwayStartedAt: 1_000,
    planningHorizonAt: 1_000 + WEEK_MS,
  })
})

test("missing, stale, or expired allowance evidence admits only an hourly fleet turn", () => {
  assert.deepEqual(usagePolicy([], 1_000), {
    pace: "unverified",
    minimumIntervalMs: 60 * 60 * 1_000,
    throttleRatio: 0.25,
  })
  assert.equal(
    usagePolicy([checkpoint(100)], 1_000 + 12 * 60 * 60 * 1_000 + 1).pace,
    "unverified",
  )
  assert.equal(
    usagePolicy([checkpoint(100)], 1_000 + WEEK_MS).pace,
    "unverified",
  )
})

test("weekly runway selects progressively tighter autonomous pacing", () => {
  const halfway = 1_000 + WEEK_MS / 2
  const paceAt = (remainingPercent: number) =>
    usagePolicy(
      [
        checkpoint(100),
        {
          capturedAt: halfway,
          remainingPercent,
          resetAt: 1_000 + WEEK_MS,
        },
      ],
      halfway,
    ).pace
  assert.equal(paceAt(60), "open")
  assert.equal(paceAt(40), "guarded")
  assert.equal(paceAt(25), "critical")
  assert.equal(paceAt(5), "reserve")
})

test("runway starts at the first verified mid-cycle checkpoint", () => {
  const capturedAt = 1_000
  const resetAt = capturedAt + WEEK_MS
  const halfway = capturedAt + WEEK_MS / 2
  const policy = usagePolicy(
    [
      { capturedAt, remainingPercent: 79, resetAt },
      { capturedAt: halfway, remainingPercent: 40, resetAt },
    ],
    halfway,
  )
  assert.equal(policy.targetRemainingPercent, 39.5)
  assert.equal(policy.runwayStartedAt, capturedAt)
})

test("an allowance increase rebases the runway instead of preserving stale burn", () => {
  const capturedAt = 1_000
  const resetAt = capturedAt + WEEK_MS
  const refillAt = capturedAt + WEEK_MS / 2
  const policy = usagePolicy(
    [
      { capturedAt, remainingPercent: 79, resetAt },
      {
        capturedAt: capturedAt + WEEK_MS / 4,
        remainingPercent: 65,
        resetAt,
      },
      { capturedAt: refillAt, remainingPercent: 94, resetAt },
    ],
    refillAt,
  )
  assert.equal(policy.targetRemainingPercent, 94)
  assert.equal(policy.runwayStartedAt, refillAt)
  assert.equal(policy.pace, "unverified")
  assert.equal(policy.throttleRatio, 0.25)
})

test("future checkpoints cannot govern an earlier decision", () => {
  assert.equal(
    usagePolicy([{ ...checkpoint(100), capturedAt: 2_000 }], 1_000).pace,
    "unverified",
  )
})

test("open pacing removes autonomous cadence while pressure preserves role weights", () => {
  assert.deepEqual(rolePollingPolicy("moneymentum-operator", "open"), {
    role: "moneymentum-operator",
    baseIntervalMs: 4 * 60 * 60 * 1_000,
    weight: 1,
    effectiveIntervalMs: 60_000,
    tokenScale: 1,
  })
  assert.deepEqual(rolePollingPolicy("moneymentum-operator", "critical"), {
    role: "moneymentum-operator",
    baseIntervalMs: 4 * 60 * 60 * 1_000,
    weight: 1,
    effectiveIntervalMs: 16 * 60 * 60 * 1_000,
    tokenScale: 0.25,
  })
  assert.equal(
    rolePollingPolicy("yielduck-operator", "critical").effectiveIntervalMs,
    16 * 60 * 60 * 1_000,
  )
})

test("each st0x agent receives twice the allocation of every other agent", () => {
  const now = 10 * 60 * 60 * 1_000
  const st0x = agentAllocation(
    "/Users/example/code/st0x/st0x.liquidity",
    now,
    now,
  )
  const other = agentAllocation(
    "/Users/example/code/dataclique/yielduck",
    now,
    now,
  )

  assert.equal(st0x.configuredWeight, 2)
  assert.equal(other.configuredWeight, 1)
  assert.equal(st0x.effectiveWeight, other.effectiveWeight * 2)
})

test("agent allocation decays smoothly toward a nonzero progress floor", () => {
  const now = 10 * 60 * 60 * 1_000
  const recent = agentAllocation("/Users/example/code/project", now, now)
  const twoHoursOld = agentAllocation(
    "/Users/example/code/project",
    now - 2 * 60 * 60 * 1_000,
    now,
  )
  const never = agentAllocation("/Users/example/code/project", undefined, now)

  assert.equal(recent.effectiveWeight, 1)
  assert.equal(twoHoursOld.effectiveWeight, 0.625)
  assert.equal(never.effectiveWeight, 0.25)
})

test("combined capacity follows the same measured runway controller", () => {
  const now = 1_000 + 60 * 60 * 1_000
  const policy = usagePolicy(
    [
      checkpoint(120),
      {
        capturedAt: now,
        remainingPercent: 113,
        resetAt: 1_000 + WEEK_MS,
      },
    ],
    now,
  )
  const tokenPolicy = providerTokenPolicy(policy, {
    observedBurnPercent: 7,
    observedTokens: 7_000,
    tokensPerPercent: 1_000,
  })

  assert.equal(policy.actualRemainingPercent, 113)
  assert.ok(policy.throttleRatio > 0)
  assert.ok(policy.throttleRatio < 1)
  assert.ok((tokenPolicy?.permittedTokensPerHour ?? 0) > 0)
  assert.ok((tokenPolicy?.capacityTokens ?? 0) > 0)
})

test("unknown roles share the conservative general budget", () => {
  assert.deepEqual(rolePollingPolicy("unknown", "guarded"), {
    role: "general",
    baseIntervalMs: 4 * 60 * 60 * 1_000,
    weight: 1,
    effectiveIntervalMs: 8 * 60 * 60 * 1_000,
    tokenScale: 0.5,
  })
})

test("recent allowance burn continuously scales autonomous work", () => {
  const resetAt = Date.parse("2026-08-20T02:56:00-03:00")
  const now = Date.parse("2026-08-14T21:00:00-03:00")
  const result = usagePolicy(
    [
      {
        capturedAt: Date.parse("2026-08-13T13:42:00-03:00"),
        remainingPercent: 96,
        resetAt,
      },
      {
        capturedAt: Date.parse("2026-08-14T11:42:48-03:00"),
        remainingPercent: 49,
        resetAt,
      },
      { capturedAt: now, remainingPercent: 7, resetAt },
    ],
    now,
  )
  assert.equal(result.pace, "reserve")
  assert.equal(result.throttleRatio, 0)
  assert.ok((result.observedBurnPercentPerHour ?? 0) > 3)
  assert.ok((result.permittedBurnPercentPerHour ?? 1) < 0.04)
  assert.ok((result.estimatedExhaustionAt ?? resetAt) < resetAt)
})

test("recent flat allowance samples decay an earlier burn spike", () => {
  const start = Date.parse("2026-08-18T00:00:00-03:00")
  const resetAt = Date.parse("2026-08-21T22:45:00-03:00")
  const spikeEnd = start + 30 * 60 * 1_000
  const now = spikeEnd + 6 * 60 * 60 * 1_000
  const flatSamples = Array.from({ length: 6 }, (_value, index) => ({
    capturedAt: spikeEnd + (index + 1) * 60 * 60 * 1_000,
    remainingPercent: 27,
    resetAt,
  }))

  const result = usagePolicy(
    [
      { capturedAt: start, remainingPercent: 30, resetAt },
      { capturedAt: spikeEnd, remainingPercent: 27, resetAt },
      ...flatSamples,
    ],
    now,
  )

  assert.ok((result.observedBurnPercentPerHour ?? Number.POSITIVE_INFINITY) < 1)
  assert.ok(result.throttleRatio > 0.1)
})

test("five percent hard reserve denies workflow token spend", () => {
  const resetAt = Date.parse("2026-08-20T02:56:00-03:00")
  const now = Date.parse("2026-08-14T21:41:00-03:00")
  const result = usagePolicy(
    [
      {
        capturedAt: Date.parse("2026-08-14T21:00:00-03:00"),
        remainingPercent: 7,
        resetAt,
      },
      { capturedAt: now, remainingPercent: 5, resetAt },
    ],
    now,
  )
  const role = rolePollingPolicy(
    "yielduck-operator",
    result.pace,
    result.throttleRatio,
  )
  assert.equal(result.pace, "reserve")
  assert.equal(role.tokenScale, 0)
  assert.equal(workflowTokenBudget(800_000, role).allowed, false)
  assert.equal(workflowTokenBudget(800_000, role).grantedTokens, 0)
})

test("workflow budgets scale by continuous role pressure", () => {
  const role = rolePollingPolicy("reviewer", "critical", 0.2)
  assert.deepEqual(workflowTokenBudget(800_000, role), {
    allowed: true,
    requestedTokens: 800_000,
    grantedTokens: 160_000,
  })
  assert.equal(workflowTokenBudget(4_000, role).allowed, false)
})
