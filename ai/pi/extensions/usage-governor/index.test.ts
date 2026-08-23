import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8")
const homeConfig = readFileSync(
  new URL("../../../../home.nix", import.meta.url),
  "utf8",
)

test("turn origin never demotes the session-selected driver model", () => {
  assert.match(source, /before_agent_start/)
  assert.doesNotMatch(source, /AUTONOMOUS_MODEL/)
  assert.doesNotMatch(source, /auto→terra/)
  assert.match(source, /restorePreferredModel/)
  assert.match(
    source,
    /activeTurnLane = turn\.lane[\s\S]*?awaitPreferredModel\(ctx\)/,
  )
})

test("workflow fan-out waits for a live allowance-scaled token grant", () => {
  assert.match(source, /pi\.on\("tool_call"/)
  assert.match(source, /event\.toolName !== "workflow"/)
  assert.match(source, /kind: "workflow", requestedTokens/)
  assert.match(source, /event\.input\.tokenBudget = admission\.grantedTokens/)
  assert.match(source, /awaitWorkflowAdmission/)
  assert.doesNotMatch(source, /Workflow blocked: OpenAI allowance pacing/)
  assert.doesNotMatch(source, /Workflow blocked: usage control is unavailable/)
})

test("provider pacing queues calls at the request boundary without aborting turns", () => {
  assert.match(source, /pi\.on\("before_provider_request"/)
  assert.match(source, /awaitProviderCallReservation/)
  assert.doesNotMatch(source, /ctx\.abort\(\)/)
  assert.doesNotMatch(source, /return \{ action: "handled" \}/)
})

test("CLI exposes a persistent refreshable throttle HUD before dashboard polish", () => {
  assert.match(source, /controlPlaneUsageControlUrl/)
  assert.match(source, /ThrottleHudComponent/)
  assert.match(source, /ctx\.ui\.setWidget\([\s\S]*?"usage-throttle"/)
  assert.match(source, /placement: "aboveEditor"/)
  assert.match(source, /ctx\.ui\.setStatus\([\s\S]*?"usage-throttle"/)
  assert.match(source, /pi\.registerCommand\("throttle"/)
  assert.match(source, /THROTTLE_REFRESH_MS = 60_000/)
  assert.match(source, /session_shutdown[\s\S]*?clearInterval\(throttleTimer\)/)
})

test("in-flight throttle refreshes cannot touch stale UI after reload", () => {
  const refresh = source.indexOf("const refreshThrottle")
  const awaitResult = source.indexOf("await Effect.runPromise", refresh)
  const epochCheck = source.indexOf(
    "if (lifecycleEpoch !== throttleLifecycleEpoch) return",
    awaitResult,
  )
  const uiAccess = source.indexOf("ctx.ui.setStatus", awaitResult)
  assert.ok(refresh >= 0 && awaitResult > refresh)
  assert.ok(epochCheck > awaitResult && uiAccess > epochCheck)
  assert.match(
    source,
    /session_shutdown[\s\S]*?throttleLifecycleEpoch \+= 1[\s\S]*?clearInterval\(throttleTimer\)/,
  )
})

test("owner intervention follows successful delegation to the target agent", () => {
  assert.match(source, /OWNER_INTERVENTION_QUERY_EVENT/)
  assert.match(source, /OWNER_INTERVENTION_RELAY_EVENT/)
  assert.match(source, /recordRelayedOwnerIntervention/)
  assert.match(source, /ctx\.sessionManager\.getSessionId\(\)/)
  assert.match(source, /event\.source !== "extension"/)
})

test("subscription models have bounded per-turn output budgets", () => {
  assert.match(homeConfig, /"gpt-5\.6-sol"\.maxTokens = 32000;/)
  assert.match(homeConfig, /"gpt-5\.6-terra"\.maxTokens = 16000;/)
  assert.match(homeConfig, /"gpt-5\.6-luna"\.maxTokens = 16000;/)
})

test("all turns restore the session-selected subscription model", () => {
  assert.match(source, /HUMAN_TURN_EVENT/)
  assert.match(source, /RESPONSIVE_AUTONOMOUS_TURN_EVENT/)
  assert.match(
    source,
    /activeTurnLane = turn\.lane[\s\S]*?awaitPreferredModel\(ctx\)/,
  )
  assert.match(
    source,
    /turn\.lane === "human"[\s\S]*?"usage:provider-budgeted · interactive"/,
  )
  assert.match(
    source,
    /turn\.lane === "responsive"[\s\S]*?"usage:provider-budgeted · responsive"/,
  )
  assert.match(
    source,
    /restorePreferredModel[\s\S]*?switchModel\(preferred, preferredModel\.thinking \?\? "high"\)/,
  )
  assert.match(source, /pi\.appendEntry\(STATE_ENTRY, selected\)/)
})
