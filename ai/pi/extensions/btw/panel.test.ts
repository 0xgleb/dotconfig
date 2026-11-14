import assert from "node:assert/strict"
import test from "node:test"
import { ManagerAnswerPanel } from "./index.ts"

test("answer panel pages through the answer with terminal PageDown and PageUp input", () => {
  let renders = 0
  const panel = new ManagerAnswerPanel(
    "Question",
    Array.from({ length: 50 }, (_, index) => `answer-${index + 1}`).join("\n"),
    "fixture-model",
    { fg: (_color, text) => text, bold: text => text },
    () => {},
    () => {
      renders += 1
    },
  )
  const text = () => panel.render(100).join("\n")

  assert.ok(text().includes("answer-1 "))
  panel.handleInput("\u001b[6~")
  assert.ok(!text().includes("answer-1 "))
  assert.ok(text().includes("answer-9 "))
  panel.handleInput("\u001b[5~")
  assert.ok(text().includes("answer-1 "))
  assert.equal(renders, 2)
})
