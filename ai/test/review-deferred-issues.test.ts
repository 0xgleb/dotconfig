import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

const source = readFileSync(
  new URL("../skills/review-loop/SKILL.md", import.meta.url),
  "utf8",
)
const deferred = source.split("## 10. ")[1]?.split("## 11. ")[0] ?? ""

test("deferred review findings use GitHub with exact per-issue approval", () => {
  assert.ok(deferred.startsWith("Defer-to-GitHub loop"))
  assert.ok(
    deferred.includes(
      "Every deferred review finding requires exact per-issue approval",
    ),
  )
  assert.ok(deferred.includes("no planning-issue creation authority"))
  assert.ok(deferred.includes("Reuse an existing exact"))
  assert.ok(deferred.includes("--body-file <approved-file>"))
  assert.equal(/\bLinear\b|Bash\(linear:|\.linear\.toml/.test(source), false)
})

test("deferred issue drafts preserve privacy and truthful metadata", () => {
  assert.ok(
    deferred.includes("never copy private correspondence or internal logs"),
  )
  assert.ok(
    deferred.includes("public-safe summary of the verifier's rationale"),
  )
  assert.ok(deferred.includes("verified public PR or commit link"))
  assert.ok(deferred.includes("Use labels that exist in the repository"))
  assert.equal(deferred.includes("Priority:"), false)
  assert.equal(deferred.includes("## Proposed fix"), false)
  assert.ok(
    deferred.includes(
      "reconcile remote state before retries to avoid duplicates",
    ),
  )
})
