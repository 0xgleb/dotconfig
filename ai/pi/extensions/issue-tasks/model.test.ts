import assert from "node:assert/strict"
import test from "node:test"
import { Either, Schema } from "effect"
import { StatusSchema } from "./model.ts"

const decode = Schema.decodeUnknownEither(StatusSchema, {
  onExcessProperty: "error",
})

test("blocked is a lifecycle variant carrying a validated reason", () => {
  for (const status of [
    "todo",
    "doing",
    "done",
    "cancelled",
    {
      _tag: "blocked",
      reason: "Requires a verified dependency",
    },
  ]) {
    const result = decode(status)
    assert.ok(Either.isRight(result))
    assert.deepEqual(result.right, status)
  }
})

test("blocked status requires a nonempty valid reason", () => {
  for (const reason of [undefined, null, "", " ", 0, "invalid\u0000reason"])
    assert.ok(Either.isLeft(decode({ _tag: "blocked", reason })))
})
