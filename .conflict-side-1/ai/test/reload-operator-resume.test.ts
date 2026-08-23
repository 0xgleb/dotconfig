import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

const read = (path: string): string =>
  readFileSync(new URL(path, import.meta.url), "utf8")
const classified = read("../pi/extensions/classified-workflows/index.ts")
const registry = read("../pi/extensions/agent-registry/index.ts")

test("manual reload uses the documented command boundary without stale lifecycle contexts", () => {
  const command = classified.slice(
    classified.indexOf('pi.registerCommand("reload-runtime"'),
    classified.indexOf('pi.registerTool({\n    name: "reload_pi"'),
  )
  assert.match(command, /await ctx\.reload\(\)/)
  assert.match(command, /reloadFailureDiagnostic\(request, error\)/)
  assert.match(
    classified,
    /wasRunAborted\(event\.messages\)[\s\S]*!managedReloadPreemptPending/,
  )
  assert.doesNotMatch(classified, /manualReloadPending/)
  assert.doesNotMatch(classified, /scheduleManualReload/)
  assert.doesNotMatch(classified, /manualReloadExecutionScheduler/)
  assert.match(
    classified,
    /pi\.sendUserMessage\(`\/reload-runtime tool:\$\{requestId\}`,[\s\S]*?expandPromptTemplates: true/,
  )
})

test("a successfully reclaimed managed operator waits for its polling tick", () => {
  assert.match(registry, /const resumedRole = await autoClaimOperationalRole/)
  assert.match(registry, /resumedRole && event\.reason !== "reload"/)
  assert.match(
    registry,
    /Managed operational role held for the next polling tick/,
  )
  assert.doesNotMatch(
    registry,
    /pi\.events\.emit\(MANAGED_OPERATIONAL_ROLE_RESUMED_EVENT, resumed\)/,
  )
})
