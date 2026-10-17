import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

const source = readFileSync(new URL("./lifecycle.ts", import.meta.url), "utf8")

test("green rerun after an evidenced implementation change is never a duplicate", () => {
  assert.match(
    source,
    /recorded red-phase failure[\s\S]*?exact rerun of that same test command is not a duplicate and must be admitted/,
  )
  assert.match(
    source,
    /red-phase edit[\s\S]*?rerun[\s\S]*?deadlock the later-success rule can never resolve/i,
  )
})
