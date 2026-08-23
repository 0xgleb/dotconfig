import assert from "node:assert/strict"
import test from "node:test"

import { shouldDetachForegroundWorkflow } from "./foreground-detach.ts"

test("human steering detaches a foreground workflow", () => {
  assert.equal(
    shouldDetachForegroundWorkflow("steer", "interactive", true),
    true,
  )
  assert.equal(shouldDetachForegroundWorkflow("steer", "rpc", true), true)
})

test("follow-ups and extension messages do not detach foreground work", () => {
  assert.equal(
    shouldDetachForegroundWorkflow("followUp", "interactive", true),
    false,
  )
  assert.equal(
    shouldDetachForegroundWorkflow("steer", "extension", true),
    false,
  )
  assert.equal(
    shouldDetachForegroundWorkflow("steer", "interactive", false),
    false,
  )
})
