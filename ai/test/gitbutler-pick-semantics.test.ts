import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

const read = (path: string): string =>
  readFileSync(new URL(path, import.meta.url), "utf8")

const skill = read("../skills/gitbutler/SKILL.md")
const reference = read("../skills/gitbutler/references/reference.md")

test("GitButler pick documentation preserves 0.22.0 stack-top semantics", () => {
  for (const document of [skill, reference]) {
    assert.match(
      document,
      /targets? an applied \*\*stack\*\*|selects an applied stack/,
    )
    assert.match(document, /first\/top branch|stack's top branch/)
    assert.match(
      document,
      /Naming a lower branch[^.]*not|desired destination is lower/,
    )
    assert.match(document, /do not use `but undo`/i)
  }
})
