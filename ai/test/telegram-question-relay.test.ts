import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

const read = (path: string): string =>
  readFileSync(new URL(path, import.meta.url), "utf8")

const questions = read("../pi/extensions/questions/index.ts")
const remote = read("../pi/extensions/remote-control/index.ts")
const telegram = read("../pi/extensions/remote-control/piece-of-pi.ts")

test("pending questions publish to the exact remote Pi session", () => {
  assert.match(questions, /pi\.events\.emit\(QUESTION_STATE_EVENT, snapshot\)/)
  assert.match(remote, /store\.syncQuestions\(/)
  assert.match(remote, /agentId: ctx\.sessionManager\.getSessionId\(\)/)
})

test("Telegram replies return only through the typed question resolution event", () => {
  assert.match(telegram, /update\.message\.replyToMessageId/)
  assert.match(telegram, /answerTelegramQuestion\(/)
  assert.match(telegram, /not attached to a pending Pi question/)
  assert.match(remote, /store\.takeQuestionResolution\(/)
  assert.match(
    remote,
    /pi\.events\.emit\(QUESTION_REMOTE_RESOLUTION_EVENT, answer\)/,
  )
  assert.match(questions, /QUESTION_REMOTE_RESOLUTION_EVENT/)
  assert.match(
    questions,
    /resolveQuestion\(latestCtx, resolution\.id, resolution\.answer\)/,
  )
})
