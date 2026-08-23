import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8")

test("real Pi failures automatically become deduplicated pi-support incidents", () => {
  assert.match(source, /pi\.on\("tool_result"[\s\S]*?event\.isError/)
  assert.match(source, /pi\.on\("agent_end"[\s\S]*?stopReason !== "error"/)
  assert.match(source, /isExplicitUserCancellation/)
  assert.match(source, /shouldRouteToolFailureToAgentops/)
  assert.match(
    source,
    /hasOpenAgentopsIncident\(snapshot\.requests, incident\)/,
  )
  assert.match(
    source,
    /project: join\(homedir\(\), "\.config"\)[\s\S]*?role: "pi-support"/,
  )
  assert.match(
    source,
    /priority: incident\.severity === "error" \? "urgent" : "normal"/,
  )
})

test("forced compaction aborts are consumed as typed control flow, not incidents", () => {
  assert.match(source, /SAFE_COMPACTION_INTERRUPT_EVENT/)
  assert.match(
    source,
    /pi\.events\.on\([\s\S]*?SAFE_COMPACTION_INTERRUPT_EVENT[\s\S]*?compactionInterruptionPending = true/,
  )
  assert.match(
    source,
    /const expectedCompactionInterruption =[\s\S]*?compactionInterruptionPending[\s\S]*?assistant\.errorMessage === "This operation was aborted"[\s\S]*?assistant\.errorMessage === "terminated"/,
  )
  assert.match(source, /compactionInterruptionPending = false/)
  assert.match(source, /expectedCompactionInterruption[\s\S]*?return/)
})

test("cross-project terminal outcomes stay out of unrelated model context", () => {
  const syncStart = source.indexOf("  const sync = async")
  const outcomeEnd = source.indexOf("      snapshot = await run", syncStart)
  const outcomeSource = source.slice(syncStart, outcomeEnd)
  assert.match(outcomeSource, /terminalOutcomeBelongsToContext/)
  assert.match(outcomeSource, /ctx\.ui\.notify\(/)
  assert.doesNotMatch(outcomeSource, /pi\.sendMessage\(/)
})

test("request mutations resolve an exact id or unique prefix to the canonical id", () => {
  assert.match(
    source,
    /id === requestedRequestId \|\| id\.startsWith\(requestedRequestId\)/,
  )
  assert.match(source, /const requestId = target\.id/)
  assert.match(source, /request prefix is ambiguous/)
})

test("all receipts remain passive even when the request is urgent", () => {
  const syncStart = source.indexOf("  const sync = async")
  const syncEnd = source.indexOf("  const autoClaimOperationalRole", syncStart)
  assert.ok(syncStart >= 0 && syncEnd > syncStart)
  const syncSource = source.slice(syncStart, syncEnd)
  assert.match(syncSource, /store\.heartbeatAgent\(/)
  assert.match(syncSource, /store\.heartbeat\(/)
  assert.match(syncSource, /ctx\.isIdle\(\)/)
  assert.match(syncSource, /!ctx\.hasPendingMessages\(\)/)
  assert.match(syncSource, /!autoReloadPending\(\)/)
  assert.match(syncSource, /requestNotificationText\(/)
  assert.match(syncSource, /requestNotificationDetails\(/)
  assert.match(syncSource, /store\.receiveRequest\(/)
  assert.match(syncSource, /newest\.priority === "urgent"/)
  assert.match(
    syncSource,
    /This urgent registry receipt remains passive until the next polling or human turn/,
  )
  assert.doesNotMatch(syncSource, /triggerTurn: true/)
  assert.match(
    syncSource,
    /This passive receipt waits for the next polling tick/,
  )
  assert.match(syncSource, /notifiedRequests\.add\(request\.id\)/)
  assert.match(syncSource, /persistNotifiedRequests\(\)/)
  assert.doesNotMatch(syncSource, /store\.claimRequest\(/)
  assert.doesNotMatch(syncSource, /dispatchOperationalTriage/)
})

test("project-scoped listings filter the returned snapshot before rendering", () => {
  assert.match(source, /registrySnapshotForProject\(snapshot, project\)/)
  assert.match(source, /registryListText\(listedSnapshot, agent\.id, now\)/)
  assert.match(
    source,
    /details: \{[\s\S]*?outcome: "success",[\s\S]*?action: request\.action,[\s\S]*?snapshot: listedSnapshot,[\s\S]*?\}/,
  )
})

test("delegate results show bounded request content instead of only queue metadata", () => {
  assert.match(
    source,
    /renderResult\(result, \{ expanded, isPartial \}, theme, context\)/,
  )
  assert.match(source, /context\.args\.action !== "delegate"/)
  assert.match(
    source,
    /boundedRegistryRequestPreview\([\s\S]*?context\.args\.text/,
  )
  assert.match(source, /Request content/)
  assert.match(source, /delivery pending recipient receipt/i)
  assert.match(source, /requestDeliveryStatus\(durableRequest\)/)
})

test("owner-directed delegation attributes intervention to the receiving agent", () => {
  assert.match(source, /OWNER_INTERVENTION_QUERY_EVENT/)
  assert.match(
    source,
    /const ownerInteractionAt = currentOwnerIntervention\(pi\)/,
  )
  assert.match(
    source,
    /targetAgentId: lease\.owner\.id,[\s\S]*?targetCwd: project,[\s\S]*?ownerInteractionAt/,
  )
  assert.match(
    source,
    /pi\.events\.emit\(OWNER_INTERVENTION_RELAY_EVENT, relay\)/,
  )
})

test("startup and sync abandon captured contexts when reload shuts down their runtime", () => {
  assert.match(source, /let lifecycleEpoch = 0/)
  assert.match(source, /let activeLifecycleEpoch: number \| undefined/)
  assert.match(
    source,
    /const sync = async \([\s\S]*?expectedEpoch = activeLifecycleEpoch/,
  )
  assert.match(source, /expectedEpoch !== activeLifecycleEpoch/)
  assert.match(
    source,
    /const epoch = \+\+lifecycleEpoch[\s\S]*?activeLifecycleEpoch = epoch[\s\S]*?await sync\(ctx, false, epoch\)/,
  )
  assert.match(
    source,
    /pi\.on\("session_shutdown"[\s\S]*?activeLifecycleEpoch = undefined/,
  )
})

test("destructive clear requires explicit confirmation and preserves one project tree", () => {
  assert.match(source, /request\.action === "clear"/)
  assert.match(source, /clear all registry state except preserved project/)
  assert.match(
    source,
    /store\.clearExceptProject\(\{ preservedProject, now \}\)/,
  )
})

test("registry outcome handler stores the resolved full id, not the requested prefix", () => {
  assert.match(source, /request\.id\.startsWith\(payload\.requestId\)/)
  assert.match(source, /request id prefix is ambiguous/)
  assert.match(source, /store\.claimRequest\(\{\s*requestId: target\.id,/)
  assert.match(source, /store\.completeRequest\(\{\s*requestId: target\.id,/)
  assert.match(source, /store\.failRequest\(\{\s*requestId: target\.id,/)
})
