import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

const source = readFileSync(
  new URL("../pi/extensions/agent-registry/index.ts", import.meta.url),
  "utf8",
)

test("registry request receipts survive reload and compaction", () => {
  assert.match(
    source,
    /NOTIFIED_REQUESTS_ENTRY = "agent-registry\.notified-requests"/,
  )
  assert.match(source, /restoreNotifiedRequests\(ctx\)/)
  assert.match(
    source,
    /notifiedRequests\.add\(request\.id\)[\s\S]*persistNotifiedRequests\(\)/,
  )
  assert.match(
    source,
    /pi\.on\("session_compact", \(\) => persistNotifiedRequests\(\)\)/,
  )
})

test("notification epoch replays pre-receipt backlog once after upgrade", () => {
  assert.match(source, /NOTIFICATION_EPOCH = 5/)
  assert.match(source, /entry\.data\.epoch !== NOTIFICATION_EPOCH/)
  assert.match(source, /epoch: NOTIFICATION_EPOCH,[\s\S]*ids:/)
})

test("registry receipts target only queued work for the current active lease", () => {
  assert.match(
    source,
    /prioritizedActiveReceiptLeases\(\s*snapshot,\s*agent\.id,?\s*\)/,
  )
  assert.match(source, /candidate\.project === lease\.project/)
  assert.match(source, /candidate\.role === lease\.role/)
  assert.match(source, /candidate\.status === "queued"/)
  assert.doesNotMatch(source, /candidate\.recipientLeaseId !== lease\.id/)
  assert.match(source, /MAX_RECEIPTS_PER_NOTIFICATION = 64/)
  assert.match(source, /\.slice\(0, MAX_RECEIPTS_PER_NOTIFICATION\)/)
  assert.match(source, /store\s*\.\s*receiveRequest\(\{/)
})

test("registry inbox wakes operational roles without preempting active input", () => {
  assert.match(source, /registryReceiptAvailable\(\{/)
  assert.match(source, /notificationsEnabled,/)
  assert.match(source, /idle: ctx\.isIdle\(\)/)
  assert.match(source, /pendingMessages: ctx\.hasPendingMessages\(\)/)
  assert.match(source, /editorText: ctx\.ui\.getEditorText\(\)/)
  assert.match(source, /autoReloadPending: autoReloadPending\(\)/)
  assert.match(
    source,
    /requests\.find\(\(\{ priority \}\) => priority === "urgent"\)/,
  )
  assert.match(source, /const operational = lease\.mode === "operational"/)
  assert.match(
    source,
    /This operational receipt started a turn to inspect and prioritize the request/,
  )
  assert.match(
    source,
    /This task-role receipt remains passive until the next polling or human turn/,
  )
  assert.match(
    source,
    /operational\s*\? \{ triggerTurn: true, deliverAs: "followUp" \}\s*: \{ deliverAs: "followUp" \}/,
  )
  assert.match(source, /let notificationSent = false/)
  assert.match(source, /if \(!newest \|\| notificationSent\) continue/)
  assert.match(
    source,
    /details: requestNotificationDetails\(newest, requests\.length - 1\)/,
  )
  assert.match(source, /registerMessageRenderer\(MESSAGE_TYPE/)
})

test("automatic receipt notices never contain the request body", () => {
  assert.match(source, /content: `\$\{requestNotificationText\(newest\)\}/)
  assert.doesNotMatch(
    source,
    /content: `\$\{requestNotificationText\(newest\)\}[\s\S]{0,400}request\.text/,
  )
})
