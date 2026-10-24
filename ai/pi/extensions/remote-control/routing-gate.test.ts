import assert from "node:assert/strict"
import test from "node:test"

import { canClaimRemoteTurn, settleTaskContinuation } from "./routing-gate.ts"

test("the next remote message waits for post-reply routing to settle", () => {
  assert.equal(canClaimRemoteTurn(false, "idle"), true)
  assert.equal(canClaimRemoteTurn(true, "idle"), false)
  assert.equal(canClaimRemoteTurn(false, "queued"), false)
  assert.equal(canClaimRemoteTurn(false, "running"), false)
})

test("only an observed running continuation settles the claim gate", () => {
  assert.equal(settleTaskContinuation("idle"), "idle")
  assert.equal(settleTaskContinuation("queued"), "queued")
  assert.equal(settleTaskContinuation("running"), "idle")
})
