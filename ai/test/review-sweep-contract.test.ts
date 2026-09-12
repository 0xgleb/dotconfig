import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

const source = readFileSync(
  new URL("../skills/review-sweep/SKILL.md", import.meta.url),
  "utf8",
)

test("sweep retirement preserves managed-main and reviewer boundaries", () => {
  assert.equal(/\bgraphite\b/i.test(source), false)
  assert.equal(
    /\bLinear\b|\blinear\s+issue\b|Bash\(linear:/.test(source),
    false,
  )
  assert.ok(
    source.includes('if [ "$repo_root" != "$main_root" ]; then tool=none'),
  )
  assert.ok(
    source.includes(
      "Explicit repository-local instructions may select a different",
    ),
  )
  assert.ok(
    source.includes(
      "NEVER modify their code, NEVER submit a verdict, NEVER push",
    ),
  )
  assert.ok(
    source.includes("Every pending review must have an empty top-level body"),
  )
  assert.ok(source.includes("push only modified series"))
  assert.ok(source.includes('case "$current_branch" in'))
  assert.ok(source.includes("gitbutler/*) tool=gitbutler"))
  assert.ok(source.includes("*) tool=none"))
  assert.ok(source.includes("use `but push <branch-name>`"))
  assert.ok(source.includes("Never use bare `but push`"))
})

test("sweep bounds select applied series without inventing a trunk", () => {
  assert.ok(source.includes("keep every branch in every applied series"))
  assert.ok(
    source.includes("Reject bounds in different series or with `E` before `S`"),
  )
  assert.ok(source.includes("With no bounds, do not filter"))
  assert.equal(source.includes("upstack of trunk"), false)
  assert.equal(source.includes("drop stacks containing neither"), false)
})

test("sweep review evidence belongs to verified committed branch identities", () => {
  assert.ok(
    source.includes(
      "Missing or ambiguous base/head identity blocks that branch",
    ),
  )
  assert.ok(source.includes("do not guess a trunk"))
  assert.ok(source.includes("Git diff between verified parent/head SHAs"))
  assert.ok(
    source.includes("committed source via `git show <branch_sha>:<path>`"),
  )
  assert.match(
    source,
    /combined working tree is not\s+source evidence for an individual branch/,
  )
  assert.doesNotMatch(source, /Reviewers read the working tree/)
  assert.ok(source.includes("Stop the sweep on a stuck branch"))
})
