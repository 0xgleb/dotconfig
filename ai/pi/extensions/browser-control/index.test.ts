import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8")

test("status and fetch never wait for page-indicator CDP work", () => {
  assert.match(
    source,
    /const pageVisibleActivity = action === "open" \|\| action === "text"/,
  )
  assert.match(
    source,
    /if \(pageVisibleActivity\) await queuePageActivity\(true\)/,
  )
  assert.match(source, /let activePageOperations = 0/)
  assert.match(
    source,
    /if \(activeBrowserOperations === 0\) \{[\s\S]*?if \(pageVisibleActivity\) await queuePageActivity\(false\)/,
  )
  assert.match(
    source,
    /else if \(pageVisibleActivity && activePageOperations === 0\)\s+await queuePageActivity\(false\)/,
  )
})
