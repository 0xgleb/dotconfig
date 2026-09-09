import assert from "node:assert/strict"
import { readdirSync, readFileSync } from "node:fs"
import { extname, join } from "node:path"
import test from "node:test"

const excludedDirectories = new Set([
  ".tmp",
  "node_modules",
  "node_modules..home-manager.bak",
  "test-fixtures",
  "testdata",
])

const productionTypeScript = (root: string): readonly string[] =>
  readdirSync(root, { withFileTypes: true }).flatMap(entry => {
    const path = join(root, entry.name)
    if (entry.isDirectory())
      return excludedDirectories.has(entry.name)
        ? []
        : productionTypeScript(path)
    if (
      extname(entry.name) !== ".ts" ||
      entry.name.endsWith(".test.ts") ||
      entry.name.endsWith(".spec.ts")
    )
      return []
    return [path]
  })

test("production TypeScript never throws", () => {
  for (const source of productionTypeScript(
    new URL("../", import.meta.url).pathname,
  ))
    assert.doesNotMatch(readFileSync(source, "utf8"), /\bthrow\b/u, source)
})
