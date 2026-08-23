import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { visibleWidth } from "@earendil-works/pi-tui"

import { framedChromeInset } from "../shared/chrome.ts"
import {
  decodeThrottleControl,
  throttleHudLines,
  throttleStatusText,
} from "./throttle-hud.ts"

const source = readFileSync(
  new URL("./throttle-hud.ts", import.meta.url),
  "utf8",
)

const fixture = {
  computedAt: Date.parse("2026-08-17T23:54:00-03:00"),
  provider: "openai",
  pool: "codex-app-server-weekly",
  source: "codex-app-server",
  profile: { kind: "flat-until-reset", participants: 1 },
  policy: {
    pace: "critical",
    minimumIntervalMs: 2_800_000,
    throttleRatio: 0.32,
    actualRemainingPercent: 44,
    targetRemainingPercent: 53.3,
    resetAt: Date.parse("2026-08-21T22:45:00-03:00"),
    observedBurnPercentPerHour: 1.33,
    permittedBurnPercentPerHour: 0.43,
    estimatedExhaustionAt: Date.parse("2026-08-20T12:00:00-03:00"),
  },
  calibration: {
    observedBurnPercent: 16,
    observedTokens: 1_000_000,
    tokensPerPercent: 62_500,
  },
  providerBudget: {
    capacityTokens: 106_768,
    permittedTokensPerHour: 26_692,
    windowMs: 14_400_000,
  },
  activity: {
    windowMs: 900_000,
    inFlightCalls: 1,
    reservedTokens: 120_000,
    counts: {
      admitted: 4,
      deferred: 3,
      scaled: 2,
      settled: 3,
      blocked: 0,
    },
    pausedRoles: [
      {
        role: "moneymentum-operator",
        retryAt: Date.parse("2026-08-18T00:10:00-03:00"),
      },
    ],
    latest: {
      at: Date.parse("2026-08-17T23:53:30-03:00"),
      kind: "workflow",
      outcome: "scaled",
      role: "reviewer",
      requestedTokens: 800_000,
      grantedTokens: 200_000,
    },
  },
  roles: [
    {
      role: "general",
      baseIntervalMs: 14_400_000,
      weight: 1,
      effectiveIntervalMs: 45_000_000,
      tokenScale: 0.32,
    },
    {
      role: "reviewer",
      baseIntervalMs: 7_200_000,
      weight: 2,
      effectiveIntervalMs: 11_250_000,
      tokenScale: 0.64,
    },
    {
      role: "yielduck-operator",
      baseIntervalMs: 3_600_000,
      weight: 2.5,
      effectiveIntervalMs: 4_500_000,
      tokenScale: 0.8,
    },
    {
      role: "moneymentum-operator",
      baseIntervalMs: 18_000_000,
      weight: 1,
      effectiveIntervalMs: 56_250_000,
      tokenScale: 0.32,
    },
  ],
} as const

test("typed throttle control rejects malformed or invented policy state", () => {
  assert.ok(decodeThrottleControl(fixture))
  assert.equal(
    decodeThrottleControl({
      ...fixture,
      policy: { ...fixture.policy, throttleRatio: 1.5 },
    }),
    undefined,
  )
  assert.equal(
    decodeThrottleControl({
      ...fixture,
      profile: { kind: "night-mode", participants: 1 },
    }),
    undefined,
  )
})

test("compact CLI status states only the current slowdown in plain language", () => {
  const control = decodeThrottleControl(fixture)
  assert.ok(control)
  const status = throttleStatusText(control)
  assert.match(status, /throttle · 68% slower/)
  assert.match(status, /32% of normal/)
  assert.match(status, /OpenAI 44% left/)
  assert.doesNotMatch(status, /provider|reserved|tokens|calls/)
})

test("agent recency changes the displayed slowdown without exposing counters", () => {
  const control = decodeThrottleControl({
    ...fixture,
    allocation: {
      configuredWeight: 2,
      recencyFactor: 0.5,
      effectiveWeight: 1,
    },
  })
  assert.ok(control)

  const status = throttleStatusText(control)
  assert.match(status, /84% slower/)
  assert.match(status, /16% of normal/)
  const hud = throttleHudLines(control, 180).join("\n")
  assert.match(hud, /THROTTLE · 84% SLOWER/)
  assert.match(hud, /ST0x receives 2× share/)
})

test("semantic content color never recolors the single-color frame", () => {
  assert.match(source, /colorThrottleRow/)
  assert.match(
    source,
    /theme\.fg\("borderAccent", line\.slice\(0, firstBorder \+ 1\)\)/,
  )
  assert.match(source, /theme\.fg\(contentColor/)
  assert.match(source, /theme\.fg\("borderAccent", line\.slice\(lastBorder\)\)/)
})

test("CLI throttle HUD is expressive, responsive, and aligned with other HUDs", () => {
  const control = decodeThrottleControl(fixture)
  assert.ok(control)
  for (const width of [40, 76, 120, 180]) {
    const lines = throttleHudLines(control, width)
    assert.ok(lines.length >= 1)
    assert.ok(lines.every(line => visibleWidth(line) <= width))
    if (width >= 76)
      assert.ok(
        lines.every(line => line.search(/\S/u) === framedChromeInset(width)),
      )
  }
  assert.equal(throttleHudLines(control, 180).length, 3)
  const expanded = throttleHudLines(control, 76, true).join("\n")
  assert.match(expanded, /capacity/)

  const wide = throttleHudLines(control, 180, true).join("\n")
  assert.match(wide, /THROTTLE · 68% SLOWER/)
  assert.match(wide, /NOW · Agent work is running now at the paced rate/)
  assert.match(wide, /latest · workflow reviewer scaled 800\.0k→200\.0k/)
  assert.match(wide, /15m · 4 admitted · 3 deferred · 2 scaled · 3 settled/)
  assert.match(wide, /OpenAI 44% left · 9\.3pt behind/)
  assert.match(
    wide,
    /burn 1\.33%\/h observed · 0\.43%\/h permitted · 3\.1× over pace/,
  )
  assert.match(wide, /flat 24\/7 · 1 owner/)
  assert.match(
    wide,
    /general 32% · reviewer 64% · yielduck 80% · moneymentum 32%/,
  )
})
