import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

const source = readFileSync(
  new URL("../skills/audit/SKILL.md", import.meta.url),
  "utf8",
)

test("audit uses GitHub without retired tracker or organization defaults", () => {
  assert.doesNotMatch(source, /\b(?:linear|graphite|st0x|rainlanguage)\b/i)
  assert.ok(source.includes("Use GitHub issues with problem-only descriptions"))
  assert.ok(
    source.includes('if [ "$repo_root" != "$main_root" ]; then tool=git'),
  )
  assert.ok(source.includes("without probing `but`"))
})

test("audit retains per-finding approval and draft-only publication gates", () => {
  assert.ok(
    source.includes("one issue per finding with a problem-only description"),
  )
  assert.match(
    source,
    /Show each\s+exact draft and obtain confirmation before creating it/,
  )
  assert.ok(
    source.includes("Confirm the PR plan before creating any branch or PR"),
  )
  assert.ok(source.includes("drafts assigned to self"))
  assert.ok(source.includes("never merge, never override branch protection"))
  assert.ok(
    source.includes("Clean tree to start; never leak unrelated changes"),
  )
})
