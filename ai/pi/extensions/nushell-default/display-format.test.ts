import assert from "node:assert/strict"
import test from "node:test"
import { nushellToolPreviewLines } from "./core.ts"
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

test("unchanged formatter output wraps even in a wide pane", () => {
  const raw =
    'with-env {MODE: "fixture"} { [1 2 3 4] | each {|x| $x + 100 }; assert true; print "fixture done" }'
  for (const width of [45]) {
    const { commandLines } = nushellToolPreviewLines(raw, undefined, width)
    assert.ok(commandLines.length > 1)
    assert.ok(commandLines.every(line => line.length <= width))
  }
  assert.deepEqual(nushellToolPreviewLines(raw, undefined, 140).commandLines, [
    `$ ${raw}`,
  ])
})
