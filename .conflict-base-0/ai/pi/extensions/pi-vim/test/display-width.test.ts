import assert from "node:assert/strict"
import test from "node:test"
import { displayColumn } from "../display-width.ts"

test("display columns account for wide and astral characters", () => {
  assert.equal(displayColumn("a界b", 2), 3)
  assert.equal(displayColumn("a🙂b", 3), 3)
})
