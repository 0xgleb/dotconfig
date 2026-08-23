import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8")

test("release cadence restores across branch lifecycle and clears session timers", () => {
  assert.match(source, /pi\.on\("session_start"/)
  assert.match(source, /pi\.on\("session_tree"/)
  assert.match(source, /pi\.on\("session_compact"/)
  assert.match(source, /pi\.on\("session_shutdown"/)
  assert.match(source, /restoreReleaseCadenceState\(persisted, now\)/)
  assert.match(source, /MAX_TIMER_DELAY_MS/)
})

test("due reminders yield to humans, pauses, and reload before follow-up delivery", () => {
  assert.match(source, /isContinuationPaused/)
  assert.match(source, /ctx\.hasPendingMessages\(\)/)
  assert.match(source, /autoReloadPending\(\)/)
  assert.match(source, /pi\.on\("agent_settled"/)
  assert.match(source, /triggerTurn: true, deliverAs: "followUp"/)
  assert.doesNotMatch(source, /setEditorText|pasteToEditor|zellij/)
})

test("hourly reminders wake only the live Yielduck operator and never surface as human-only entries", () => {
  assert.match(source, /REGISTRY_IDENTITY_REQUEST_EVENT/)
  assert.match(
    source,
    /role === "operator" && identity\.mode === "operational"/,
  )
  assert.match(source, /display: false/)
  assert.doesNotMatch(
    source,
    /registerEntryRenderer|REMINDER_ENTRY|appendEntry\(REMINDER_ENTRY|without starting another agent turn/,
  )
})

test("cadence remains explicitly disableable and markers require live verification", () => {
  assert.match(source, /\["status", "enable", "disable", "mark"\]/)
  assert.match(
    source,
    /Use release_cadence mark only after a safe dashboard or live version marker has been verified/,
  )
  assert.match(source, /\/release-cadence \[status\|enable\|disable\]/)
  assert.match(source, /hourly release reminders/)
})
