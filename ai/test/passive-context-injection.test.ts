import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

const read = (path: string) =>
  readFileSync(new URL(path, import.meta.url), "utf8")
const questions = read("../pi/extensions/questions/index.ts")
const registry = read("../pi/extensions/agent-registry/index.ts")

test("pending questions enrich the system prompt without creating transcript messages", () => {
  assert.match(
    questions,
    /before_agent_start[\s\S]*systemPrompt: `\$\{event\.systemPrompt\}\\n\\n\$\{content\}`/,
  )
  assert.doesNotMatch(questions, /customType: "pi\.questions\.context"/)
})

test("owned registry roles enrich the system prompt without creating transcript messages", () => {
  assert.match(
    registry,
    /before_agent_start[\s\S]*systemPrompt: `\$\{event\.systemPrompt\}\\n\\n\$\{content\}`/,
  )
  assert.doesNotMatch(registry, /customType: "agent-registry\.context"/)
})
