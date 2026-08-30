import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

const read = (path: string): string =>
  readFileSync(new URL(path, import.meta.url), "utf8")

const agents = read("../AGENTS.md")
const graphite = read("../skills/graphite/SKILL.md")
const nushell = read("../skills/nushell/SKILL.md")

test("global PR guidance requires file-backed multiline bodies and remote verification", () => {
  assert.match(agents, /Transport Markdown as real bytes/)
  assert.match(agents, /--body-file/)
  assert.match(agents, /gh pr view <number-or-url> --json body --jq \.body/)
})

test("Graphite PR guidance never uses global temp or escaped body strings", () => {
  assert.match(graphite, /--body-file \.tmp\/pr-body\.md/)
  assert.match(graphite, /gh pr view <PR_NUMBER> --json body --jq \.body/)
  assert.doesNotMatch(graphite, /\/tmp\/pr-body\.md/)
})

test("Nushell guidance detects literal newline escapes after publication", () => {
  assert.match(nushell, /Publishing multiline Markdown/)
  assert.match(nushell, /str contains '\\n'/)
  assert.match(
    nushell,
    /command\s+success proves transport, not correct Markdown rendering/,
  )
})
