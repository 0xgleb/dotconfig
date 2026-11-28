import assert from "node:assert/strict"
import test from "node:test"
import { commandOutcome } from "./outcome.ts"

test("distinguishes policy refusal from command failure and success", () => {
  assert.deepEqual(
    commandOutcome(true, "Auto-classifier verdict: outside scope", false),
    { icon: "▲", explanation: "outside scope" },
  )
  assert.equal(commandOutcome(true, "exit 2", true).icon, "✖")
  assert.equal(
    commandOutcome(true, "Auto-classifier verdict: refusal", true, {
      blockedBeforeExecution: true,
    }).icon,
    "▲",
  )
  assert.equal(
    commandOutcome(false, "Auto-classifier verdict: literal output", true).icon,
    "",
  )
})
