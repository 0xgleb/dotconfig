import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8")

test("terminal request outcomes queue at the next safe boundary while a turn is active", () => {
  assert.match(
    source,
    /for \(const request of notificationsEnabled &&\s*!ctx\.hasPendingMessages\(\) &&\s*!autoReloadPending\(\)/,
  )
  assert.match(
    source,
    /Registry request[\s\S]*?This passive update must not preempt a human prompt[\s\S]*?\{ deliverAs: "followUp" \}/,
  )
})

test("request mutations resolve an exact id or unique prefix to the canonical id", () => {
  assert.match(
    source,
    /id === requestedRequestId \|\| id\.startsWith\(requestedRequestId\)/,
  )
  assert.match(source, /const requestId = target\.id/)
  assert.match(source, /request prefix is ambiguous/)
})

test("the dispatch lane heartbeats its role but never claims queue requests", () => {
  assert.match(
    source,
    /import \{ isLocalDispatchProvider \} from "\.\.\/shared\/local-lane\.ts"/,
  )
  assert.match(
    source,
    /const candidates: readonly RegistryRequest\[\] = isLocalDispatchProvider\(\s*ctx\.model\?\.provider,\s*\)\s*\?\s*\[\]\s*:\s*snapshot\.requests\.filter\(/,
  )
  assert.match(
    source,
    /const candidates: readonly RegistryRequest\[\] = isLocalDispatchProvider[\s\S]*?store\.claimRequest\(\{/,
  )
  assert.match(
    source,
    /store\.heartbeatAgent\(\{[\s\S]*?store\.heartbeat\(\{[\s\S]*?const candidates: readonly RegistryRequest\[\] = isLocalDispatchProvider/,
  )
})

test("registry outcome handler stores the resolved full id, not the requested prefix", () => {
  assert.match(source, /request\.id\.startsWith\(payload\.requestId\)/)
  assert.match(source, /request id prefix is ambiguous/)
  assert.match(source, /store\.claimRequest\(\{\s*requestId: target\.id,/)
  assert.match(source, /store\.completeRequest\(\{\s*requestId: target\.id,/)
  assert.match(source, /store\.failRequest\(\{\s*requestId: target\.id,/)
})
