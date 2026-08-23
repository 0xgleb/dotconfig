import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

const renderer = readFileSync(
  new URL("../pi/extensions/compact-read/index.ts", import.meta.url),
  "utf8",
)

test("interactive sessions start with tool output expanded", () => {
  assert.match(renderer, /pi\.on\("session_start"/)
  assert.match(renderer, /ctx\.mode === "tui"/)
  assert.match(renderer, /ctx\.ui\.setToolsExpanded\(true\)/)
})
