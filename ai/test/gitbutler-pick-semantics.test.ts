import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

const read = (path: string): string =>
  readFileSync(new URL(path, import.meta.url), "utf8")

const skill = read("../skills/gitbutler/SKILL.md")
const reference = read("../skills/gitbutler/references/reference.md")

test("GitButler pick guidance describes explicit branch and relative placement", () => {
  const skillStart = skill.indexOf("- Copy commits")
  const referenceStart = reference.indexOf("### but pick <SOURCES>...")
  assert.ok(skillStart >= 0, "missing skill pick guidance")
  assert.ok(referenceStart >= 0, "missing reference pick guidance")

  const sections = [
    skill.slice(skillStart, skill.indexOf("- Move committed", skillStart)),
    reference.slice(referenceStart).split(/\n### /)[0],
  ]

  for (const section of sections) {
    const normalized = section.replace(/\s+/g, " ")
    assert.match(
      normalized,
      /on that applied branch's tip|on the branch BRANCH/,
    )
    assert.match(
      normalized,
      /new independent branch|created as an unstacked branch/,
    )
    assert.match(normalized, /--above/)
    assert.match(normalized, /--below/)
  }
})
