import assert from "node:assert/strict"
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
