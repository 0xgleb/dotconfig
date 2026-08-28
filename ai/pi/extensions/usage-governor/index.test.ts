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

test("workflow fan-out admission is bypassed while throttling is disabled", () => {
  assert.match(
    source,
    /const throttlingMode = \(\): "disabled" \| "enabled" => "disabled"/,
  )
  assert.match(source, /pi\.on\("tool_call"/)
  assert.match(
    source,
    /if \(throttlingMode\(\) === "disabled" \|\| event\.toolName !== "workflow"\) return/,
  )
  assert.match(source, /kind: "workflow", requestedTokens/)
  assert.match(source, /event\.input\.tokenBudget = admission\.grantedTokens/)
  assert.match(source, /awaitWorkflowAdmission/)
  assert.doesNotMatch(source, /Workflow blocked: OpenAI allowance pacing/)
  assert.doesNotMatch(source, /Workflow blocked: usage control is unavailable/)
})

test("provider pacing is bypassed while throttling is disabled", () => {
  assert.match(source, /pi\.on\("before_provider_request"/)
  assert.match(source, /awaitProviderCallReservation/)
  assert.match(
    source,
    /if \(throttlingMode\(\) === "enabled"\)[\s\S]*?await awaitProviderCallReservation\(ctx\)/,
  )
  assert.doesNotMatch(source, /ctx\.abort\(\)/)
  assert.doesNotMatch(source, /return \{ action: "handled" \}/)
})

test("disabled throttling does not start or render the throttle HUD", () => {
  assert.match(source, /controlPlaneUsageControlUrl/)
  assert.match(source, /ThrottleHudComponent/)
  assert.match(source, /pi\.registerCommand\("throttle"/)
  assert.match(
    source,
    /if \(throttlingMode\(\) === "disabled"\) {[\s\S]*?"Throttling is disabled"/,
  )
  assert.match(
    source,
    /session_start[\s\S]*?if \(throttlingMode\(\) === "disabled"\) {[\s\S]*?setWidget\("usage-throttle", undefined\)[\s\S]*?return/,
  )
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

test("all turns restore the session-selected subscription model without claiming throttling", () => {
  assert.match(source, /HUMAN_TURN_EVENT/)
  assert.match(source, /RESPONSIVE_AUTONOMOUS_TURN_EVENT/)
  assert.match(
    source,
    /activeTurnLane = turn\.lane[\s\S]*?awaitPreferredModel\(ctx\)/,
  )
  assert.match(source, /"usage:unthrottled"/)
  assert.doesNotMatch(source, /usage:provider-budgeted/)
  assert.match(
    source,
    /restorePreferredModel[\s\S]*?switchModel\(preferred, preferredModel\.thinking \?\? "high"\)/,
  )
  assert.match(source, /pi\.appendEntry\(STATE_ENTRY, selected\)/)
})
