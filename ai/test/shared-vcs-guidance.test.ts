import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

const instructions = readFileSync(
  new URL("../AGENTS.md", import.meta.url),
  "utf8",
)
const worktree = readFileSync(
  new URL("../skills/worktree/SKILL.md", import.meta.url),
  "utf8",
)

test("shared worktree examples require isolation and use stable role slots", () => {
  const section =
    instructions.split("## Git Worktrees")[1]?.split("## This Repository")[0] ??
    ""
  assert.ok(section.includes("concrete isolation"))
  assert.ok(section.includes(".worktrees/secondary"))
  assert.ok(!section.includes(".worktrees/feat/my-feature"))
})

test("worktree detection compares absolute Git directories without adding another suffix", () => {
  assert.ok(worktree.includes("git rev-parse --path-format=absolute --git-dir"))
  assert.ok(
    worktree.includes("git rev-parse --path-format=absolute --git-common-dir"),
  )
  assert.ok(worktree.includes('"$git_dir" != "$common_dir"'))
  assert.ok(!worktree.includes('"$common_dir/.git"'))
})
