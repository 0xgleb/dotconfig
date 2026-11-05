import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

const instructions = readFileSync(
  new URL("../../GLOBAL_AGENTS.md", import.meta.url),
  "utf8",
)

test("canonical instructions fail typed invariants at the narrowest boundary", () => {
  assert.match(
    instructions,
    /persisted state, external responses, configuration, arithmetic/,
  )
  assert.match(instructions, /narrowest boundary/)
  assert.match(instructions, /specific typed error/)
  assert.match(instructions, /never panics, silently coerces/)
  assert.match(instructions, /malformed or impossible shape/)
})

test("mechanical abstractions keep domain control flow and errors visible", () => {
  assert.match(instructions, /genuinely mechanical\s+boilerplate/)
  assert.match(instructions, /control flow, types, and error/)
  assert.match(instructions, /explicit code instead/)
})
