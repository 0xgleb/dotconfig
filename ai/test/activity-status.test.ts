import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

const activity = readFileSync(
  new URL("../pi/extensions/activity-status/index.ts", import.meta.url),
  "utf8",
)
const activityCore = readFileSync(
  new URL("../pi/extensions/activity-status/core.ts", import.meta.url),
  "utf8",
)
const workflows = readFileSync(
  new URL("../pi/extensions/classified-workflows/index.ts", import.meta.url),
  "utf8",
)

test("live activity phases derive from concrete Pi runtime events", () => {
  for (const event of [
    "agent_start",
    "turn_start",
    "message_update",
    "tool_execution_start",
    "tool_execution_update",
    "tool_execution_end",
    "session_before_compact",
    "session_compact",
  ]) {
    assert.match(activity, new RegExp(`pi\\.on\\(\\"${event}\\"`))
  }
  assert.match(activityCore, /REASONING · model generation · no tools implied/)
  assert.match(
    activity,
    /CLASSIFIER · \$\{event\.boundary\} · model generation/,
  )
  assert.match(activityCore, /SUBAGENT/)
  assert.match(activity, /COMPACTING/)
})

test("long-running tool UX is transient, elapsed, and content-safe", () => {
  assert.match(activity, /setInterval/)
  assert.match(activity, /event\.partialResult/)
  assert.match(
    activity,
    /setWidget\(\s*TOOL_PROGRESS_WIDGET_KEY,[\s\S]*?alignChromeLine\(label, width\)/,
  )
  assert.match(
    activity,
    /setProgressWidget\(withQuestionLabel\(phase\.label\), ctx\)/,
  )
  assert.match(activity, /const READY_LABEL = "READY · awaiting activity"/)
  assert.match(activity, /QUESTION_PENDING_COUNT_EVENT/)
  assert.match(activity, /ACTION REQUIRED.*\/questions/)
  assert.match(activity, /setProgressWidget\(questionLabel\(\), ctx\)/)
  assert.match(activityCore, /bufferedLineCount/)
  assert.match(activityCore, /elapsedSeconds/)
  assert.doesNotMatch(activity, /event\.args/)
  assert.doesNotMatch(activityCore, /details\.command|partialResult\.details/)
})

test("classifier status is emitted only around actual model classifier calls", () => {
  assert.match(workflows, /onActivity\?\.\(true\)/)
  assert.match(workflows, /finally \{\s*onActivity\?\.\(false\)/)
  assert.match(workflows, /pi\.events\.emit\(ACTIVITY_PHASE_EVENT, event\)/)
})
