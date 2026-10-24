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
    const body = guidance.slice(guidance.indexOf("\n") + 1)
    assert.doesNotMatch(body, /^#{2,3} /m)
    assert.match(guidance, /workspace-wide graph/i)
    assert.match(
      guidance,
      /consistent with.*upstream workspace-graph failure/is,
    )
    assert.match(guidance, /Failed to merge bases while cherry picking commit/i)
    assert.match(guidance, /issues\/12065/)
    assert.match(guidance, /issues\/15112/)
    assert.match(guidance, /do not retry[^.]*while[^.]*unresolved/i)
    assert.match(guidance, /preserve the conflicted commit and its order/i)
    assert.match(guidance, /independently authorized/i)
    assert.match(
      guidance,
      /independently authorized.*consider a retry only after.*recovery.*verification of a clean graph/is,
    )
    assert.match(
      guidance,
      /unrelated task already authorizes.*linked\/non-main worktree from a verified clean live head.*use plain Git there/is,
    )
    assert.match(guidance, /leave the.*GitButler workspace untouched/i)
    assert.match(guidance, /do not[^.]*raw Git/i)
    assert.match(guidance, /main worktree/i)
  }
})
