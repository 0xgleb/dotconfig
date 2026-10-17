import assert from "node:assert/strict"
import test from "node:test"
import { decodeSafeCompactionInterrupt } from "./safe-compaction-events.ts"

test("only the exact typed overflow interruption marker is accepted", () => {
  assert.deepEqual(
    decodeSafeCompactionInterrupt({
      reason: "overflow",
      expectedError: "This operation was aborted",
    }),
    {
      reason: "overflow",
      expectedError: "This operation was aborted",
    },
  )
  assert.equal(
    decodeSafeCompactionInterrupt({
      reason: "threshold",
      expectedError: "This operation was aborted",
    }),
    undefined,
  )
  assert.equal(
    decodeSafeCompactionInterrupt({
      reason: "overflow",
      expectedError: "unrelated failure",
    }),
    undefined,
  )
})
