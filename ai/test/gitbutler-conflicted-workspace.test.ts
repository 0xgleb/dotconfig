import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

const read = (path: string): string =>
  readFileSync(new URL(path, import.meta.url), "utf8")

const skill = read("../skills/gitbutler/SKILL.md")
const reference = read("../skills/gitbutler/references/reference.md")

const section = (document: string, heading: RegExp): string => {
  const start = document.search(heading)
  assert.notEqual(start, -1, `missing section ${heading}`)
  const rest = document.slice(start)
  const next = rest.search(/\n#{2,3} /)
  return next === -1 ? rest : rest.slice(0, next)
}

test("standing recovery authorization covers blocked workspace graphs without a second approval", () => {
  const global = read("../../GLOBAL_AGENTS.md").replace(/\s+/g, " ")
  const start = global.indexOf("- Local-conflict reconciliation exception:")
  const end = global.indexOf("- Corrective-publication exception:", start)
  assert.ok(start >= 0 && end > start)
  const exception = global.slice(start, end)
  assert.match(exception, /No additional owner approval is required/)
  assert.match(
    exception,
    /standing permission satisfies the GitButler guidance's independently authorized recovery requirement/,
  )
  assert.match(
    exception,
    /another applied conflicted commit blocks reconciliation/,
  )
  assert.match(
    exception,
    /raw-Git prohibitions apply outside this bounded exception/,
  )
  assert.match(
    exception,
    /normal whole-workspace `but pull`, conflict resolution and bare `but push` workflow/,
  )
})

test("GitButler guidance contains the conflicted workspace recovery boundary", () => {
  const sections = [
    section(
      skill,
      /^### A conflicted applied stack can block unrelated mutations$/m,
    ),
    section(
      reference,
      /^### Workspace-graph failure while another commit is conflicted$/m,
    ),
  ]

  for (const guidance of sections) {
    const normalized = guidance.replace(/\s+/g, " ")
    assert.match(normalized, /workspace-wide graph/i)
    assert.match(
      normalized,
      /Failed to merge bases while cherry picking commit/i,
    )
    assert.match(normalized, /do not retry[^.]*while[^.]*unresolved/i)
    assert.match(normalized, /preserve the conflicted commit and its order/i)
    assert.match(
      normalized,
      /independently authorized.*consider a retry only after recovery and verification of a clean graph/i,
    )
    assert.match(
      normalized,
      /unrelated task already authorizes an existing linked\/non-main worktree from a verified clean live head, use plain Git there/i,
    )
    assert.match(
      normalized,
      /leave the affected GitButler workspace untouched/i,
    )
    assert.match(normalized, /do not use raw Git.*managed main worktree/i)
  }
})
