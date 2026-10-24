import assert from "node:assert/strict"
import { existsSync, readFileSync } from "node:fs"
import test from "node:test"

const skillPath = new URL("../skills/power-unslop/SKILL.md", import.meta.url)

test("power-unslop is available as a shared, purpose-aware agent skill", () => {
  assert.ok(existsSync(skillPath), "the requested shared skill must exist")
  const skill = readFileSync(skillPath, "utf8")
  assert.match(skill, /^---\nname: power-unslop\n/)
  assert.match(skill, /explicit objective to the critic/i)
  for (const purpose of [
    "Specification:",
    "PR description:",
    "Decision question:",
    "Owner report:",
    "Stakeholder update:",
    "Interactive reply:",
  ]) {
    assert.ok(skill.includes(purpose), `missing purpose: ${purpose}`)
  }
  assert.match(skill, /critique-only requests.*then stop/is)
  assert.match(skill, /fresh read-only critic each round/i)
  assert.match(skill, /criticism only, not edits/i)
  assert.match(skill, /not a quota of three/i)
  assert.match(skill, /ask_user.*report_owner/is)
  assert.match(skill, /current artifact.*reviewed hash/is)
})
