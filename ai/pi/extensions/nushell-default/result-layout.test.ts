import assert from "node:assert/strict"
import test from "node:test"
import { resultRows } from "./result-layout.ts"

test("the outcome sits next to output without moving its timing row", () => {
  assert.deepEqual(resultRows("check", ["", "  ", "output", "", "Took 1s"]), [
    "",
    "  ",
    "check",
    "output",
    "",
    "Took 1s",
  ])
  assert.deepEqual(resultRows("check", []), ["", "check"])
})
