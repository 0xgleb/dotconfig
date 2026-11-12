import assert from "node:assert/strict"
import test from "node:test"
import { Either, Schema } from "effect"
import { TaskBlockerSchema } from "./model.ts"

const decode = Schema.decodeUnknownEither(TaskBlockerSchema, {
  onExcessProperty: "error",
})

test("blocking states distinguish unblocked work from a validated blocking reason", () => {
  for (const state of [
    { _tag: "Unblocked" },
    { _tag: "Blocked", reason: "Requires a verified dependency" },
  ]) {
    const result = decode(state)
    assert.ok(Either.isRight(result))
    assert.deepEqual(result.right, state)
  }
})

test("blocked work cannot omit its reason or carry malformed reason data", () => {
  for (const reason of [undefined, null, "", " ", 0, "invalid\u0000reason"])
    assert.ok(Either.isLeft(decode({ _tag: "Blocked", reason })))

  assert.ok(
    Either.isLeft(decode({ _tag: "Unblocked", reason: "contradiction" })),
  )
  assert.ok(Either.isLeft(decode({ _tag: "Unknown" })))
})
