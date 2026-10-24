import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

const source = readFileSync(new URL("./lifecycle.ts", import.meta.url), "utf8")

test("bounded loopback CLI reads are admitted when direct tooling is owner policy or the browser lane cannot render", () => {
  assert.match(source, /loopback CLI request/)
  assert.match(
    source,
    /browser lane demonstrably cannot render the loopback page/,
  )
  assert.match(source, /does not authorize remote hosts/)
})
