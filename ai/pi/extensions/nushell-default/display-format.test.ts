import assert from "node:assert/strict"
import test from "node:test"
import { formatCommandForDisplay } from "./display-format.ts"

test("formats nested Nushell for display and falls back to exact input", () => {
  const raw =
    'with-env {MODE: "fixture"} { [1 2] | each {|x| $x + 1 }; assert true }'
  const formatted =
    'with-env { MODE: "fixture" } {\n  [1 2] | each {|x| $x + 1 }\n  assert true\n}'
  assert.equal(
    formatCommandForDisplay(raw, input => {
      assert.equal(input, raw)
      return formatted
    }),
    formatted,
  )
  assert.equal(
    formatCommandForDisplay(raw, () => undefined),
    raw,
  )
})
