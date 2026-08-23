import assert from "node:assert/strict"
import test from "node:test"
import {
  advanceCabaSession,
  cabaSessionCard,
  initialCabaSession,
  migrateCabaSession,
  parseCabaSession,
} from "./caba-tracker.ts"

test("CABA tracker advances bounded progress and navigates without invalid state", () => {
  const started = initialCabaSession(1_000)
  assert.equal(started.step, 0)
  assert.equal(started.progress[0], 0)

  const incremented = advanceCabaSession(started, "plus")
  assert.equal(incremented.progress[0], 1)
  assert.equal(advanceCabaSession(incremented, "next").step, 1)
  assert.equal(advanceCabaSession(started, "previous").step, 0)
  assert.equal(advanceCabaSession(started, "minus").progress[0], 1)
})

test("the plan is flattened into one-tap atomic actions", () => {
  let state = initialCabaSession(1_000)
  const firstTitles: string[] = []
  for (let index = 0; index < 14; index += 1) {
    firstTitles.push(cabaSessionCard(state).text)
    state = advanceCabaSession(state, "next")
  }
  assert.match(firstTitles[0] ?? "", /Round 1 · Pull-ups/)
  assert.match(firstTitles[6] ?? "", /Round 1 · Rest/)
  assert.match(firstTitles[7] ?? "", /Round 2 · Pull-ups/)
  assert.match(firstTitles[13] ?? "", /Round 2 · Rest/)
})

test("done and undo are one reversible typed action", () => {
  const started = initialCabaSession(1_000)
  const done = advanceCabaSession(started, "toggle-done")
  assert.equal(done.progress[0], 1)
  assert.equal(advanceCabaSession(done, "toggle-done").progress[0], 0)
})

test("the previous 13-step schema migrates its completed steps without discarding progress", () => {
  const migrated = migrateCabaSession({
    status: "active",
    step: 1,
    progress: [2, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    startedAt: 1_000,
    messageId: 77,
  })
  assert.equal(migrated?.messageId, 77)
  assert.equal(
    migrated?.progress.slice(0, 14).every(value => value === 1),
    true,
  )
  assert.equal(migrated?.progress[14], 1)
})

test("persisted CABA state validates every temporal and progress invariant", () => {
  const state = { ...initialCabaSession(1_000), messageId: 77 }
  assert.deepEqual(parseCabaSession(state), state)
  assert.equal(parseCabaSession({ ...state, step: 99 }), undefined)
  assert.equal(parseCabaSession({ ...state, progress: [99] }), undefined)
  assert.equal(parseCabaSession({ ...state, startedAt: -1 }), undefined)
})

test("CABA card is compact and exposes real Telegram callback controls", () => {
  const card = cabaSessionCard(initialCabaSession(1_000))
  assert.match(card.text, /Boulder CABA/)
  assert.match(card.text, /Item 1\/90/)
  assert.equal(card.text.length < 900, true)
  const callbacks = card.replyMarkup.inline_keyboard
    .flat()
    .map(({ callback_data }) => callback_data)
  assert.deepEqual(callbacks, [
    "caba:previous",
    "caba:toggle-done",
    "caba:next",
    "caba:finish",
  ])
})
