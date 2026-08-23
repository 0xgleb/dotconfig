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
  assert.match(source, /NOTIFICATION_EPOCH = 4/)
  assert.match(source, /entry\.data\.epoch !== NOTIFICATION_EPOCH/)
  assert.match(source, /epoch: NOTIFICATION_EPOCH,[\s\S]*ids:/)
})

test("registry receipts target only queued work for the current active lease", () => {
  assert.match(
    source,
    /ownedLeases\(snapshot, agent\.id\)\.filter\([\s\S]*status === "active"/,
  )
  assert.match(source, /candidate\.project === lease\.project/)
  assert.match(source, /candidate\.role === lease\.role/)
  assert.match(source, /candidate\.status === "queued"/)
  assert.match(source, /candidate\.recipientLeaseId !== lease\.id/)
  assert.match(source, /MAX_RECEIPTS_PER_NOTIFICATION = 64/)
  assert.match(source, /\.slice\(0, MAX_RECEIPTS_PER_NOTIFICATION\)/)
  assert.match(source, /store\.receiveRequest\(\{/)
})

test("registry inbox passively receives normal and urgent work", () => {
  assert.match(
    source,
    /notificationsEnabled &&[\s\S]*ctx\.isIdle\(\) &&[\s\S]*!ctx\.hasPendingMessages\(\) &&[\s\S]*!autoReloadPending\(\)/,
  )
  assert.match(source, /newest\.priority === "urgent"/)
  assert.match(source, /This passive receipt waits for the next polling tick/)
  assert.match(
    source,
    /This urgent registry receipt remains passive until the next polling or human turn/,
  )
  assert.doesNotMatch(source, /triggerTurn: true/)
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
