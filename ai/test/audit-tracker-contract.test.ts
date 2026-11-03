import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

const source = readFileSync(
  new URL("../skills/audit/SKILL.md", import.meta.url),
  "utf8",
)
const prose = source.replace(/\s+/g, " ")

test("audit documents GitHub tracking and topology-based VCS routing", () => {
  assert.doesNotMatch(source, /\b(?:linear|graphite|st0x|rainlanguage)\b/i)
  assert.ok(prose.includes("Use GitHub issues with problem-only descriptions"))

  assert.ok(
    source.includes('if [ "$repo_root" != "$main_root" ]; then tool=git'),
  )
  assert.ok(
    source.includes(
      'elif [ -d "$git_common_dir/gitbutler" ]; then tool=gitbutler',
    ),
  )
  assert.ok(prose.includes("uses plain Git without probing `but`"))
  assert.ok(prose.includes("confirm workspace mode (`but status` ok)"))
})

test("audit separates exact issue approval from bounded publication authority", () => {
  assert.ok(
    prose.includes("one issue per finding with a problem-only description"),
  )
  assert.ok(
    prose.includes(
      "Show each exact draft and obtain confirmation before creating it",
    ),
  )

  assert.ok(
    prose.includes(
      "Confirm new publication scope before creating branches/PRs.",
    ),
  )
  assert.ok(
    prose.includes(
      "Do not ask again for the exact scoped global-resource workflow already authorized by `GLOBAL_AGENTS.md`",
    ),
  )
  assert.ok(prose.includes("unrelated extra PRs still need authority"))
  assert.ok(prose.includes("do not add unrelated clusters or external effects"))

  assert.ok(prose.includes("drafts assigned to self"))
  assert.ok(
    prose.includes(
      "Only a scoped global-resource change authorized by `GLOBAL_AGENTS.md` may be marked ready after completion and verification",
    ),
  )
  assert.match(prose, /never merge or override branch protection/i)
})

test("audit documents isolated ignore repairs before clean-tree and artifact gates", () => {
  const start = source.indexOf(
    "## 2. Detect the VCS/stacking tool and preflight",
  )
  const end = source.indexOf(
    "## 3. Prepare the workspace and build the audit target",
  )

  assert.ok(start >= 0)
  assert.ok(end > start)

  const preflight = source.slice(start, end).replace(/\s+/g, " ")
  const stateRead = preflight.indexOf("Record the working-tree/index state")
  const repair = preflight.indexOf(
    "Account for an owned ignore repair as a separate preflight unit",
  )
  const cleanliness = preflight.indexOf(
    "After accounting for the repair, require a clean working tree/index",
  )

  assert.ok(stateRead >= 0)
  assert.ok(repair > stateRead)
  assert.ok(cleanliness > repair)

  assert.ok(
    preflight.includes(
      "Complete the directory-ignore preflight before requiring a clean tree or writing artifacts",
    ),
  )
  assert.ok(
    preflight.includes(
      "on the directory itself and the intended artifact path",
    ),
  )
  assert.ok(
    preflight.includes(
      "A file-specific match does not establish directory coverage",
    ),
  )
  assert.ok(
    preflight.includes(
      "preserving existing rules and without asking for separate approval, then recheck both paths",
    ),
  )
  assert.ok(preflight.includes("this does not authorize creating a worktree"))

  assert.ok(
    preflight.includes(
      "checkpoint/publication workflow before starting the audit",
    ),
  )
  assert.ok(
    preflight.includes(
      "Isolate only the new ignore hunk; never commit pre-existing changes with it",
    ),
  )
  assert.ok(
    preflight.includes(
      "This unit is required even when the audit later finds nothing",
    ),
  )
  assert.ok(
    preflight.includes(
      "an ignore repair does not authorize an otherwise unapproved PR, merge, or branch-protection bypass",
    ),
  )
  assert.ok(
    preflight.includes(
      "leave the repair saved and report the exact blocker rather than starting another work unit",
    ),
  )

  assert.ok(
    preflight.includes(
      "report any remaining unrelated changes without discarding them",
    ),
  )
  assert.ok(
    preflight.includes(
      "Recheck ignore coverage after each checkout transition",
    ),
  )
  assert.ok(
    preflight.includes(
      "never carry an unstaged ignore repair between fix clusters",
    ),
  )
})
