import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

const read = (path: string): string =>
  readFileSync(new URL(path, import.meta.url), "utf8")
const globalAgents = read("../AGENTS.md")
const piAgents = read("../pi/AGENTS.md")

test("global and Pi agents fail typed invariants at the narrowest boundary", () => {
  for (const instructions of [globalAgents, piAgents]) {
    assert.match(
      instructions,
      /persisted state, external responses, configuration, arithmetic/,
    )
    assert.match(instructions, /narrowest boundary/)
    assert.match(instructions, /specific typed error/)
    assert.match(instructions, /never panics, silently coerces/)
    assert.match(instructions, /malformed or impossible shape/)
  }
})

test("mechanical abstractions keep domain control flow and errors visible", () => {
  for (const instructions of [globalAgents, piAgents]) {
    assert.match(instructions, /genuinely mechanical\s+boilerplate/)
    assert.match(instructions, /control flow, types, and error/)
    assert.match(instructions, /explicit code instead/)
  }
})
