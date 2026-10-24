import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

const read = (path: string): string =>
  readFileSync(new URL(path, import.meta.url), "utf8")

test("independent delegation never blocks the human foreground", () => {
  const instructions = read("../pi/AGENTS.md")
  const extension = read("../pi/extensions/classified-workflows/index.ts")
  const skill = read("../skills/pi-delegation/SKILL.md")

  for (const source of [instructions, extension, skill]) {
    assert.match(source, /background/i)
    assert.match(source, /human prompt|foreground/i)
    assert.match(source, /independent/i)
  }
})
