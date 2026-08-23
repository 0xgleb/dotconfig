import assert from "node:assert/strict"
import test from "node:test"
import {
  applyQuestionAction,
  decodeQuestionState,
  emptyQuestionState,
  pendingQuestions,
  repairMisroutedPromptAnswers,
  repeatedQuestion,
} from "./state.ts"
import { pendingQuestionContext, questionListText } from "./presentation.ts"

test("questions remain pending until explicitly resolved", () => {
  const asked = applyQuestionAction(emptyQuestionState, {
    action: "ask",
    question: "Should production operators deploy directly?",
    header: "Deployment",
    guess: "No; circuit-break only.",
    options: [
      { label: "No", description: "Circuit-break only" },
      { label: "Yes", description: "Allow direct deploys" },
    ],
  })
  assert.equal(pendingQuestions(asked).length, 1)
  assert.match(pendingQuestionContext(asked) ?? "", /Continue independent work/)
  assert.equal(pendingQuestions(asked)[0]?.header, "Deployment")
  assert.deepEqual(
    pendingQuestions(asked)[0]?.options?.map(({ label }) => label),
    ["No", "Yes"],
  )

  const resolved = applyQuestionAction(asked, {
    action: "resolve",
    id: 1,
    answer: "Confirmed: circuit-break only.",
  })
  assert.equal(pendingQuestions(resolved).length, 0)
  assert.match(questionListText(resolved), /Confirmed: circuit-break only/)
})

test("question state decoder rejects malformed partial state", () => {
  const state = applyQuestionAction(emptyQuestionState, {
    action: "ask",
    question: "Need input?",
  })
  assert.deepEqual(decodeQuestionState(state), state)
  assert.equal(
    decodeQuestionState({
      questions: [{ id: 1, status: "resolved", question: "Q" }],
      nextId: 2,
    }),
    undefined,
  )
})

test("a mistaken resolution can reopen the original question without changing its id", () => {
  const asked = applyQuestionAction(emptyQuestionState, {
    action: "ask",
    question: "Fleet grace period?",
  })
  const resolved = applyQuestionAction(asked, {
    action: "resolve",
    id: 1,
    answer: "not actually an answer",
  })
  const reopened = applyQuestionAction(resolved, { action: "reopen", id: 1 })
  assert.deepEqual(
    pendingQuestions(reopened).map(({ id, question }) => ({ id, question })),
    [{ id: 1, question: "Fleet grace period?" }],
  )
  assert.equal(reopened.nextId, 2)
})

test("a screenshot-bearing normal prompt captured as an answer is reopened", () => {
  const asked = applyQuestionAction(emptyQuestionState, {
    action: "ask",
    question: "Fleet policy?",
  })
  const mistaken = applyQuestionAction(asked, {
    action: "resolve",
    id: 1,
    answer:
      "a/var/folders/x/TemporaryItems/NSIRD_screencaptureui_x/Screenshot.png fuck you bruv i was trying to do a normal prompt so your question asking is a bug",
  })
  const repaired = repairMisroutedPromptAnswers(mistaken)
  assert.equal(pendingQuestions(repaired)[0]?.id, 1)
  assert.equal(repaired.nextId, 2)

  const legitimate = applyQuestionAction(asked, {
    action: "resolve",
    id: 1,
    answer: "Use a five-minute grace period.",
  })
  assert.deepEqual(repairMisroutedPromptAnswers(legitimate), legitimate)
})

test("clearing resolved questions preserves pending decisions", () => {
  const first = applyQuestionAction(emptyQuestionState, {
    action: "ask",
    question: "First?",
  })
  const second = applyQuestionAction(first, {
    action: "ask",
    question: "Second?",
  })
  const resolved = applyQuestionAction(second, {
    action: "resolve",
    id: 1,
    answer: "Yes",
  })
  const cleared = applyQuestionAction(resolved, { action: "clear_resolved" })
  assert.deepEqual(
    pendingQuestions(cleared).map(({ id }) => id),
    [2],
  )
})

test("resolved decisions suppress exact and narrowly reworded repeat questions", () => {
  const asked = applyQuestionAction(emptyQuestionState, {
    action: "ask",
    question:
      "No current EOD note exists. Which staging surface should I use for the first draft?",
  })
  const resolved = applyQuestionAction(asked, {
    action: "resolve",
    id: 1,
    answer: "Put the first draft directly in chat.",
  })

  assert.equal(
    repeatedQuestion(
      resolved,
      "Which staging surface should I use for the current EOD first draft?",
    )?.id,
    1,
  )
  assert.equal(
    repeatedQuestion(resolved, "Should I request changes on PR 335?"),
    undefined,
  )
})

test("short unrelated questions require exact equality before suppression", () => {
  const asked = applyQuestionAction(emptyQuestionState, {
    action: "ask",
    question: "Deploy now?",
  })
  assert.equal(repeatedQuestion(asked, "Deploy now?")?.id, 1)
  assert.equal(repeatedQuestion(asked, "Deploy later?"), undefined)
})
