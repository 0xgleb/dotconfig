import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

const read = (path: string): string =>
  readFileSync(new URL(path, import.meta.url), "utf8")
const classified = read("../pi/extensions/classified-workflows/index.ts")
const registry = read("../pi/extensions/agent-registry/index.ts")

test("manual reload overtakes stale pause and queued continuation work", () => {
  const reload = classified.slice(
    classified.indexOf("const performManualReload"),
    classified.indexOf('pi.on("agent_end"'),
  )
  assert.match(
    reload,
    /if \(continuationPaused\) setContinuationPaused\(false, ctx\)/,
  )
  assert.match(reload, /await ctx\.reload\(\)/)
  assert.match(
    classified,
    /wasRunAborted\(event\.messages\) &&\s*!manualReloadPending &&\s*!managedReloadPreemptPending/,
  )
  assert.match(
    classified,
    /pi\.on\("agent_end"[\s\S]*await performManualReload\(ctx\)/,
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
