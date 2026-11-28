import assert from "node:assert/strict"
import test from "node:test"
import { nushellToolPreviewLines } from "./core.ts"
import { breakAtNushellBoundaries } from "./display-boundaries.ts"
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

test("quoted GraphQL punctuation survives preview preprocessing", () => {
  const query = '"query { repository { name } }; | literal"'
  const command = `gh api graphql -f query=${query}`
  assert.equal(
    breakAtNushellBoundaries(`${command} | get data`, 32),
    `${command}\n  | get data`,
  )
})

test("quoted regex escapes do not hide the real pipeline boundary", () => {
  const command = String.raw`ls | where name =~ '^foo\.[ab|c];{2}$'`
  assert.equal(
    breakAtNushellBoundaries(command, 20),
    String.raw`ls
  | where name =~ '^foo\.[ab|c];{2}$'`,
  )
})

test("unchanged formatter output uses Nushell boundaries when it does not fit", () => {
  const raw =
    'with-env {MODE: "fixture"} { [1 2 3 4] | each {|x| $x + 100 }; assert true; print "fixture done" }'
  const { commandLines } = nushellToolPreviewLines(raw, undefined, 45)
  assert.ok(commandLines.some(line => line.trim() === "assert true;"))
  assert.ok(commandLines.some(line => line.trim() === "}"))
  assert.ok(commandLines.every(line => line.length <= 45))
  assert.deepEqual(nushellToolPreviewLines(raw, undefined, 140).commandLines, [
    `ν ${raw}`,
  ])
})
