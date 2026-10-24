import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8")

test("safe compaction messages render their cause with a dedicated background", () => {
  assert.match(source, /registerMessageRenderer\(MESSAGE_TYPE/)
  assert.match(source, /compactionVisual\(details\.reason, details\.phase\)/)
  assert.match(source, /theme\.bg\(visual\.background/)
})

test("active compaction blocks automatic reload from seizing the editor", () => {
  assert.match(source, /AUTO_RELOAD_ACTIVITY_REQUEST_EVENT/)
  assert.match(
    source,
    /state\.phase !== "idle" \|\|[\s\S]*?compactRequested \|\|[\s\S]*?pendingAutomaticResume !== undefined/,
  )
})

test("auto-compaction never starts a nested prompt from session_compact", () => {
  const compactStart = source.indexOf('pi.on("session_compact"')
  const settledStart = source.indexOf('pi.on("agent_settled"')

  assert.ok(compactStart >= 0 && settledStart > compactStart)
  const compactHandler = source.slice(compactStart, settledStart)
  assert.doesNotMatch(compactHandler, /triggerTurn:\s*true/)
  assert.match(
    compactHandler,
    /mode === "agent-settled"[\s\S]*?pendingAutomaticResume = completed[\s\S]*?return/,
  )
})

test("automatic no-retry compaction resumes only after the parent run settles", () => {
  assert.match(source, /let pendingAutomaticResume:/)
  assert.match(
    source,
    /compactionResumeMode\(event\.reason, event\.willRetry\)/,
  )
  assert.match(source, /mode === "agent-settled"/)
  assert.match(
    source,
    /pi\.on\("agent_settled"[\s\S]*?pendingAutomaticResume[\s\S]*?sendResume/,
  )
})

test("an automatic resume checkpoint is consumed at most once before human input", () => {
  const compactStart = source.indexOf('pi.on("session_compact"')
  const settledStart = source.indexOf('pi.on("agent_settled"')
  const compactHandler = source.slice(compactStart, settledStart)

  assert.match(
    compactHandler,
    /completed\.phase === "forced"[\s\S]*?completed\.suppressAutomaticResume[\s\S]*?return/,
  )
  assert.match(
    source.slice(settledStart),
    /const completed = pendingAutomaticResume[\s\S]*?pendingAutomaticResume = undefined[\s\S]*?sendResume\(completed\)/,
  )
})

test("compaction dispatch never escapes its active lifecycle callback", () => {
  assert.doesNotMatch(source, /setTimeout/)
  assert.doesNotMatch(source, /queueMicrotask/)
  assert.match(source, /mode === "manual-complete"\) sendResume\(completed\)/)
  assert.match(
    source,
    /pi\.on\("agent_settled"[\s\S]*?pendingAutomaticResume[\s\S]*?sendResume\(completed\)/,
  )
})

test("manual compaction may resume at completion because it has no active parent run", () => {
  assert.match(source, /mode === "manual-complete"[\s\S]*?sendResume/)
})

test("automatic compaction blocks another threshold cycle before sending its resume", () => {
  const compactStart = source.indexOf('pi.on("session_compact"')
  const settledStart = source.indexOf('pi.on("agent_settled"')
  const compactHandler = source.slice(compactStart, settledStart)

  assert.match(
    compactHandler,
    /mode === "manual-complete"[\s\S]*?thresholdBlockedSafeCompactionState/,
  )
  assert.ok(
    compactHandler.indexOf("thresholdBlockedSafeCompactionState") <
      compactHandler.indexOf("pendingAutomaticResume = completed"),
  )
})

test("a redundant compaction completion cannot clear the consumed checkpoint cooldown", () => {
  const compactStart = source.indexOf('pi.on("session_compact"')
  const settledStart = source.indexOf('pi.on("agent_settled"')
  const compactHandler = source.slice(compactStart, settledStart)

  assert.match(
    compactHandler,
    /completed\.phase === "idle" &&[\s\S]*?completed\.thresholdBlockedUntilInput[\s\S]*?thresholdBlockedSafeCompactionState/,
  )
  assert.ok(
    compactHandler.indexOf("thresholdBlockedSafeCompactionState") <
      compactHandler.indexOf("pendingAutomaticResume = completed"),
  )
})

test("only fresh non-extension input clears the automatic threshold block", () => {
  const inputStart = source.indexOf('pi.on("input"')
  const compactStart = source.indexOf('pi.on("session_before_compact"')
  const inputHandler = source.slice(inputStart, compactStart)

  assert.match(inputHandler, /event\.source === "extension"/)
  assert.match(inputHandler, /state\.thresholdBlockedUntilInput/)
  assert.match(inputHandler, /persist\(idleSafeCompactionState\)/)
})

test("forced overflow marks its expected host abort as typed control flow", () => {
  assert.match(source, /SAFE_COMPACTION_INTERRUPT_EVENT/)
  assert.match(
    source,
    /event\.reason === "overflow"[\s\S]*?transition\.state\.phase === "forced"[\s\S]*?pi\.events\.emit\(SAFE_COMPACTION_INTERRUPT_EVENT/,
  )
})

test("late readiness after forced overflow terminates quietly without another compaction", () => {
  const toolStart = source.indexOf('name: "safe_compaction_ready"')
  const tool = source.slice(toolStart)

  assert.match(
    tool,
    /state\.phase === "idle" && state\.thresholdBlockedUntilInput/,
  )
  assert.match(tool, /outcome: "already-compacted"/)
  assert.match(tool, /terminate: true/)
})
