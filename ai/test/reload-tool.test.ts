import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

import {
  reloadCommandRequest,
  reloadFailureDiagnostic,
} from "../pi/extensions/classified-workflows/manual-reload.ts"

const source = readFileSync(
  new URL("../pi/extensions/classified-workflows/index.ts", import.meta.url),
  "utf8",
)
const autoReloadSource = readFileSync(
  new URL("../pi/extensions/auto-reload/index.ts", import.meta.url),
  "utf8",
)

test("reload_pi queues the documented terminal reload command", () => {
  assert.match(source, /const requestId = randomUUID\(\)/)
  assert.match(
    source,
    /pi\.sendUserMessage\(`\/reload-runtime tool:\$\{requestId\}`,[\s\S]*deliverAs: "followUp",[\s\S]*expandPromptTemplates: true/,
  )
  assert.match(
    source,
    /Reload queued · request \$\{requestId\} · next phase: reload-runtime command/,
  )
  assert.match(
    source,
    /const request = reloadCommandRequest\(args, randomUUID\)/,
  )
  assert.match(source, /await ctx\.reload\(\)[\s\S]*return/)
  assert.match(
    source,
    /name: "reload_pi"[\s\S]*armManualReload\(ctx\)[\s\S]*pi\.sendUserMessage\(`\/reload-runtime tool:/,
  )
  assert.match(
    source,
    /pi\.on\("agent_settled"[\s\S]*if \(manualReloadPending\) return/,
  )
  assert.match(source, /MANUAL_RELOAD_FAILSAFE_MS/)
  assert.match(source, /clearManualReloadPending\(\)/)
})

test("manual reload claims and cancels any pending automatic reload", () => {
  const manualRequest = source.indexOf(
    "pi.events.emit(MANUAL_RELOAD_REQUEST_EVENT)",
  )
  const queuedCommand = source.indexOf("pi.sendUserMessage", manualRequest)
  assert.ok(manualRequest > 0)
  assert.ok(queuedCommand > manualRequest)
  assert.match(
    autoReloadSource,
    /pi\.events\.on\(\s*MANUAL_RELOAD_REQUEST_EVENT,[\s\S]*?reloadExecutionScheduler\?\.close\(\)[\s\S]*?pending = false/,
  )
})

test("reload tool explicitly dispatches its queued extension command", () => {
  const tool = source.slice(
    source.indexOf('pi.registerTool({\n    name: "reload_pi"'),
    source.indexOf('pi.registerCommand("loop"'),
  )
  assert.match(tool, /expandPromptTemplates: true/)
})

test("reload command reports progress without injecting a pre-reload model turn", () => {
  const command = source.slice(
    source.indexOf('pi.registerCommand("reload-runtime"'),
    source.indexOf('pi.registerTool({\n    name: "reload_pi"'),
  )
  assert.match(command, /ctx\.ui\.notify\([\s\S]*?Reloading Pi resources/)
  assert.doesNotMatch(command, /showLoopMessage\(/)
  assert.doesNotMatch(command, /pi\.sendMessage\(/)
})

test("reload command accepts only an internally tagged request id", () => {
  const generated = "00000000-0000-4000-8000-000000000001"
  assert.deepEqual(
    reloadCommandRequest(
      "tool:123e4567-e89b-42d3-a456-426614174000",
      () => generated,
    ),
    {
      requestId: "123e4567-e89b-42d3-a456-426614174000",
      initiator: "reload_pi",
    },
  )
  assert.deepEqual(
    reloadCommandRequest("untrusted junk", () => generated),
    {
      requestId: generated,
      initiator: "reload-runtime",
    },
  )
})

test("reload failures expose the operation, phase, initiator, request, and abort provenance", () => {
  const diagnostic = reloadFailureDiagnostic(
    {
      requestId: "123e4567-e89b-42d3-a456-426614174000",
      initiator: "reload_pi",
    },
    new DOMException("This operation was aborted", "AbortError"),
  )
  assert.match(diagnostic, /operation=ctx\.reload/)
  assert.match(diagnostic, /phase=reload-runtime-command/)
  assert.match(diagnostic, /initiator=reload_pi/)
  assert.match(diagnostic, /request=123e4567-e89b-42d3-a456-426614174000/)
  assert.match(
    diagnostic,
    /reload-succeeded=unknown \(host threw before confirmation\)/,
  )
  assert.match(diagnostic, /error=AbortError: This operation was aborted/)
  assert.match(diagnostic, /abort-source=host did not expose signal\.reason/)
})

test("reload command reports a typed diagnostic instead of rethrowing an anonymous abort", () => {
  const command = source.slice(
    source.indexOf('pi.registerCommand("reload-runtime"'),
    source.indexOf('pi.registerTool({\n    name: "reload_pi"'),
  )
  assert.match(command, /reloadFailureDiagnostic\(request, error\)/)
  assert.match(
    command,
    /clearManualReloadPending\(\)[\s\S]*reloadFailureDiagnostic/,
  )
  assert.match(command, /ctx\.ui\.notify\(diagnostic, "error"\)/)
  assert.match(command, /process\.stderr\.write/)
  assert.doesNotMatch(command, /throw error/)
})

test("manual reload pending state is bounded and cleared during shutdown", () => {
  assert.match(
    source,
    /manualReloadPending = true[\s\S]*manualReloadFailsafeTimer = setTimeout\([\s\S]*manualReloadPending = false[\s\S]*scheduleTaskContinuation\(ctx\)[\s\S]*MANUAL_RELOAD_FAILSAFE_MS/,
  )
  assert.match(
    source,
    /pi\.on\("session_shutdown"[\s\S]*clearManualReloadPending\(\)/,
  )
})
