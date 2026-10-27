import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

const instructions = readFileSync(
  new URL("../../GLOBAL_AGENTS.md", import.meta.url),
  "utf8",
)
const worktree = readFileSync(
  new URL("../skills/worktree/SKILL.md", import.meta.url),
  "utf8",
)
const worktreePolicy = instructions.replace(/\s+/g, " ")

test("worktrees require owner concurrency and stable repository-local role slots", () => {
  assert.match(
    worktreePolicy,
    /Work in the session's assigned checkout by default/,
  )
  assert.match(
    worktreePolicy,
    /Worktrees are permitted\s+ONLY when the owner or another agent launched by the owner is working on the\s+same repository concurrently with an agent/,
  )
  assert.match(
    worktreePolicy,
    /use a stable\s+repository-local role slot such as `\.worktrees\/secondary`,\s+`\.worktrees\/tertiary`, `\.tmp\/worktrees\/secondary`, or\s+`\.tmp\/worktrees\/tertiary`/,
  )
})

test("isolation and task-derived names do not justify worktrees", () => {
  assert.match(
    worktreePolicy,
    /Isolation alone, dirty local\s+state, ordinary setup, review, builds, and agent-initiated fan-out never\s+justify a worktree/,
  )
  assert.match(
    worktreePolicy,
    /never mint PR-, ticket-, branch-, timestamp-, or\s+task-named worktree directories/,
  )
})

test("worktree detection compares absolute Git directories without adding another suffix", () => {
  assert.ok(worktree.includes("git rev-parse --path-format=absolute --git-dir"))
  assert.ok(
    worktree.includes("git rev-parse --path-format=absolute --git-common-dir"),
  )
  assert.ok(worktree.includes('"$git_dir" != "$common_dir"'))
  assert.ok(!worktree.includes('"$common_dir/.git"'))
})
