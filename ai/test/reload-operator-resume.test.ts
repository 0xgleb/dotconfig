import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

const read = (path: string): string =>
  readFileSync(new URL(path, import.meta.url), "utf8")
const classified = read("../pi/extensions/classified-workflows/index.ts")
const registry = read("../pi/extensions/agent-registry/index.ts")

test("manual reload overtakes stale pause and reloads before continuation gating", () => {
  const settled = classified.slice(classified.indexOf('pi.on("agent_settled"'))
  assert.ok(
    settled.indexOf("if (manualReloadPending)") <
      settled.indexOf("if (continuationPaused) return"),
  )
  assert.match(
    settled,
    /if \(continuationPaused\) setContinuationPaused\(false, ctx\)/,
  )
  assert.match(
    classified,
    /wasRunAborted\(event\.messages\) && !manualReloadPending/,
  )
})

test("a successfully reclaimed sole managed operator resumes after restart", () => {
  assert.match(registry, /const resumedRole = await autoClaimOperationalRole/)
  assert.match(registry, /resumedRole && event\.reason !== "reload"/)
  assert.match(
    registry,
    /pi\.events\.emit\(MANAGED_OPERATIONAL_ROLE_RESUMED_EVENT, resumed\)/,
  )
  assert.match(registry, /triggerTurn: true, deliverAs: "followUp"/)
  assert.match(classified, /MANAGED_OPERATIONAL_ROLE_RESUMED_EVENT/)
  assert.match(
    classified,
    /continuationPaused && latestCtx[\s\S]*setContinuationPaused\(false, latestCtx\)/,
  )
})
