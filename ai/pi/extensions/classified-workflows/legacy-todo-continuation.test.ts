import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { taskContinuationMessage } from "./goal.ts"

test("legacy todo work cannot generate an automatic continuation", () => {
  assert.equal(
    taskContinuationMessage({
      pending: ["Old todo must not interrupt manual migration"],
      blocked: [],
      completed: [],
    }),
    undefined,
  )
})

test("automatic scheduler does not read or continue legacy todo work", () => {
  const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8")
  const scheduler = source.slice(
    source.indexOf("const scheduleTaskContinuation"),
    source.indexOf("const clearManualReloadPending"),
  )
  assert.ok(scheduler.length > 0)
  assert.doesNotMatch(scheduler, /todoWorkSnapshot|taskContinuationMessage/u)
  assert.match(scheduler, /remediationContinuationMessage/u)
})

test("explicit goal completion is not forced active by legacy todos", () => {
  const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8")
  const settled = source.slice(
    source.indexOf('pi.on("agent_settled"'),
    source.indexOf('pi.on("tool_call"'),
  )
  assert.ok(settled.length > 0)
  assert.doesNotMatch(settled, /todoWorkSnapshot|work\.pending/u)
})
