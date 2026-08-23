import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

const questions = readFileSync(
  new URL("../pi/extensions/questions/index.ts", import.meta.url),
  "utf8",
)
const workflows = readFileSync(
  new URL("../pi/extensions/classified-workflows/index.ts", import.meta.url),
  "utf8",
)

test("questions use a real overlay instead of a non-focusable below-editor widget", () => {
  assert.match(questions, /ctx\.ui\.custom<string \| null>/)
  assert.match(questions, /overlay: true/)
  assert.doesNotMatch(questions, /placement: "belowEditor"/)
  assert.match(questions, /setWidget\(QUESTION_STATUS_KEY, undefined\)/)
})

test("queued questions never auto-focus and hijack the next normal prompt", () => {
  assert.doesNotMatch(
    questions,
    /pi\.on\("agent_settled"[\s\S]*showQuestionDialog/,
  )
  assert.match(questions, /explicitly opens \/questions/)
  assert.match(questions, /Type\.Literal\("reopen"\)/)
})

test("a submitted question answer unpauses and resumes the waiting agent", () => {
  assert.match(
    questions,
    /pi\.events\.emit\(QUESTION_RESOLVED_EVENT, resolution\)/,
  )
  assert.match(questions, /Resolved durable question q\$\{id\}/)
  assert.match(questions, /exact typed answer/)
  assert.match(questions, /display: false/)
  assert.doesNotMatch(questions, /The user answered q/)
  assert.match(questions, /triggerTurn: true, deliverAs: "followUp"/)
  assert.match(workflows, /pi\.events\.on\(\s*QUESTION_RESOLVED_EVENT/)
  assert.match(workflows, /setContinuationPaused\(false, latestCtx\)/)
})
