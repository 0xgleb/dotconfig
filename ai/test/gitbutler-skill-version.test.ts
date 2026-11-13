import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import test from "node:test"

const skillPath = new URL("../skills/gitbutler/SKILL.md", import.meta.url)
const homeNixPath = new URL("../../home.nix", import.meta.url)
const skill = readFileSync(skillPath, "utf8")
const homeNix = readFileSync(homeNixPath, "utf8")

const skillVersion = (): string => {
  const match = skill.match(/^version:\s*([^\s]+)$/m)
  assert.ok(match, "GitButler skill must declare a version")
  return match[1]
}

const cliVersion = (): string => {
  const output = execFileSync("but", ["--version"], { encoding: "utf8" })
  const match = output.match(/^but\s+([^\s]+)$/m)
  assert.ok(match, `unexpected but --version output: ${output.trim()}`)
  return match[1]
}

test("managed GitButler skill matches the installed CLI", () => {
  assert.equal(skillVersion(), cliVersion())
})

test("managed GitButler skill requires a version check before history edits", () => {
  const normalized = skill.replace(/\s+/g, " ")
  assert.match(
    normalized,
    /Before any history edit or conflict resolution, compare `but --version`/,
  )
  assert.match(
    normalized,
    /Do not translate syntax from a stale version report/,
  )
})

test("native GitButler worktree guidance preserves the local routing boundary", () => {
  const documents = [
    skill,
    ...["reference.md", "concepts.md", "examples.md"].map(name =>
      readFileSync(
        new URL(`../skills/gitbutler/references/${name}`, import.meta.url),
        "utf8",
      ),
    ),
  ]
  for (const document of documents) {
    const normalized = document.replace(/\s+/g, " ")
    assert.match(
      normalized,
      /wrapper rejects (?:all invocations from |all GitButler invocations from )?linked worktrees/,
    )
    assert.match(normalized, /plain Git in linked\/non-main worktrees/)
  }
})

test("Pi panes resolve the managed GitButler wrapper before project dev shells", () => {
  assert.match(
    homeNix,
    /"\.pi\/agent\/bin\/but"\.source = "\$\{but\}\/bin\/but";/,
  )
})
