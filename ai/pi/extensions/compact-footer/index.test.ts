import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8")

test("footer render stays constant-time while the user types", () => {
  const renderStart = source.indexOf("render(width: number): string[]")
  const renderEnd = source.indexOf("\n        },", renderStart)
  assert.ok(renderStart >= 0 && renderEnd > renderStart)

  const renderBody = source.slice(renderStart, renderEnd)
  assert.doesNotMatch(
    renderBody,
    /assistantUsages|getEntries|getContextUsage|aggregateUsage/,
  )
  assert.match(source, /usageSnapshot = captureUsageSnapshot\(ctx\)/)
  assert.match(source, /footerData\.onBranchChange\(refreshUsageSnapshot\)/)
})
