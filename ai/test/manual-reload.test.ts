import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

const read = (path: string): string =>
  readFileSync(new URL(path, import.meta.url), "utf8")
const classified = read("../pi/extensions/classified-workflows/index.ts")

test("manual reload uses the documented command boundary without stale lifecycle contexts", () => {
  const command = classified.slice(
    classified.indexOf('pi.registerCommand("reload-runtime"'),
    classified.indexOf('pi.registerTool({\n    name: "reload_pi"'),
  )
  assert.match(command, /await Effect\.runPromise\(reloadAfterIdle\(ctx\)\)/)
  assert.match(command, /reloadFailureDiagnostic\(request, error\)/)
  assert.match(
    classified,
    /wasRunAborted\(event\.messages\)[\s\S]*!managedReloadPreemptPending/,
  )
  assert.match(
    classified,
    /pi\.on\("agent_settled"[\s\S]*if \(manualReloadPending\) return/,
  )
  assert.match(classified, /MANUAL_RELOAD_FAILSAFE_MS/)
  assert.match(
    classified,
    /pi\.sendUserMessage\(`\/reload-runtime tool:\$\{requestId\}`,[\s\S]*?expandPromptTemplates: true/,
  )
})
