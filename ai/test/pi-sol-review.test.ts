import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

const home = readFileSync(new URL("../../home.nix", import.meta.url), "utf8")
const skill = readFileSync(
  new URL("../skills/pi-delegation/SKILL.md", import.meta.url),
  "utf8",
)

test("Claude Code receives a classified read-only Codex Sol reviewer wrapper", () => {
  assert.match(home, /name = "pi-sol-review"/)
  assert.match(home, /env -u PI_INTERNAL_WORKFLOW_CHILD_TOKEN_LIMIT pi/)
  assert.match(
    home,
    /--extension "\$HOME\/\.config\/ai\/pi\/extensions\/classified-workflows\/index\.ts"/,
  )
  assert.match(home, /--tools read,grep,find,ls/)
  assert.match(home, /--model openai-codex\/gpt-5\.6-sol/)
  assert.doesNotMatch(home, /--tools [^\n]*(?:bash|edit|write)/)
})

test("the delegation skill routes non-Pi harnesses through the bounded wrapper", () => {
  assert.match(skill, /Claude Code and other non-Pi harnesses/)
  assert.match(skill, /run `pi-sol-review` from the repository/)
  assert.match(skill, /does not depend on agent-registry integration/)
  assert.match(skill, /does not attest that the human authorized a mutation/)
})
