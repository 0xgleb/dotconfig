---
name: audit
user-invocable: true
allowed-tools: Bash(git:*), Bash(gh:*), Bash(but:*), Bash(direnv:*), Bash(agy:*), Bash(command:*), Bash(cargo:*), Bash(nix:*), Bash(mkdir:*), Bash(cat:*), Bash(mktemp:*), Bash(rm:*), Bash(test:*), Bash(grep:*), Bash(wc:*), Bash(date:*), Bash(basename:*), Bash(find:*), Read, Write, Edit, Agent, Workflow, AskUserQuestion, Skill
description: Use to audit a whole codebase (the entire repository by default, or a specified package or path) with the multi-model review panel, then fix the actionable findings and put them up as pull requests using the project's version control or stacking tool (GitButler or plain git). Triggers on requests to audit the repo or a crate or package and open fixes for what it finds. Like review-loop, but scoped to standing code and shipping the fixes as PRs.
argument-hint: [package-or-path]
---

Audit a whole codebase with the same multi-model panel the rest of the review
stack uses, then **fix what it finds and put the fixes up as PRs**. Where
`/review-pr`, `/review-loop`, and `/review-sweep` review a **diff**, this reviews
**standing code** — the whole repo, or a package/path you name — and, like
`/review-loop`, fixes the findings; but instead of leaving fixes uncommitted it
opens one PR per coherent fix-cluster using whatever VCS/stacking tool the repo
uses.

The **review engine** is the shared `~/.claude/skills/review-core/SKILL.md`. The
**fix discipline** (triage, surgical fixes, compile gate, delta re-review,
discovered check command) is `/review-loop`'s. The **tool detection and stack
primitives** are `/review-sweep`'s. This skill adds only: a whole-repo scope (via
a synthetic diff) and a branch-per-cluster, open-a-PR action.

Follow these steps precisely.

## 1. Resolve the audit scope

`$ARGUMENTS` is an optional package or path. With no argument — the common case —
audit the **whole repository**. A whole-repo audit is the intended default: it is
expected to be large, and size alone is NEVER a reason to stop and ask. Chunk hard
(step 5) and proceed. The only scope-related stop-and-ask is a *named* scope that
fails to resolve (below); an unscoped invocation always runs the whole repo.

```bash
repo_root=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
scope="${ARGUMENTS:-.}"   # dir / crate dir / pathspec under repo_root; "." = whole repo
```

If `$ARGUMENTS` names a thing that is not a path (a bare crate name), resolve it
to its directory before continuing; if it cannot be resolved under the repo, stop
and ask rather than auditing everything by accident.

## 2. Detect the VCS/stacking tool and preflight

The action opens branches and PRs, so detect the tool (same as `/review-sweep`)
and require a clean tree.

```bash
git_common_dir=$(git -C "$repo_root" rev-parse --path-format=absolute --git-common-dir)
main_root=$(git -C "$repo_root" worktree list --porcelain | sed -n 's/^worktree //p' | head -n1)
if [ "$repo_root" != "$main_root" ]; then tool=git
elif [ -d "$git_common_dir/gitbutler" ]; then tool=gitbutler
else tool=git
fi
git -C "$repo_root" status --porcelain   # must be clean — fixes go on new branches off trunk
trunk=$(git -C "$repo_root" symbolic-ref refs/remotes/origin/HEAD --short 2>/dev/null | sed 's#^origin/##' || echo master)
start_branch=$(git -C "$repo_root" rev-parse --abbrev-ref HEAD)   # return here at the end
```

If the tree is dirty, stop and tell the user (uncommitted work would leak into
the fix branches). GitButler is
main-worktree-only; every linked, isolated, or scratch worktree uses plain Git
without probing `but`. In a verified GitButler main worktree, confirm workspace
mode (`but status` ok) as `/review-sweep` does.

## 3. Prepare the workspace and build the audit target

Render the scoped tree as an all-additions diff against the **empty tree** so the
diff-centric engine can audit standing code. Gitignored paths drop out for free;
exclude the tracked lockfiles.

```bash
ts=$(date +%Y-%m-%d_%H-%M-%S)
safe_scope=$(echo "$scope" | tr '/. ' '___')
out_dir="$repo_root/.tmp/agent-local-ctx/reviews/audit-${ts}-${safe_scope}"
mkdir -p "$out_dir"
empty=$(git -C "$repo_root" hash-object -t tree /dev/null)   # canonical empty-tree object
git -C "$repo_root" diff "$empty" HEAD -- "$scope" \
  ':(exclude)*.lock' ':(exclude)Cargo.lock' ':(exclude)flake.lock' > "$out_dir/diff.patch"
git -C "$repo_root" diff --name-status "$empty" HEAD -- "$scope" \
  ':(exclude)*.lock' ':(exclude)Cargo.lock' ':(exclude)flake.lock' > "$out_dir/files.txt"
wc -l "$out_dir/diff.patch"
```

Refuse on an empty target. A whole repo is large, so this leans hard on chunking
(step 5) — large is expected, not a blocker. **Do not stop for size confirmation
on an unscoped audit**: the whole repo is the intended default, so chunk and
proceed. A one-line heads-up that it is a long, token-heavy run is fine (and you
may note that `/audit crates/NAME` is a cheaper way to focus a follow-up), but
size alone never gates the run — only an explicit user "stop" does. (Audit `HEAD`
by default; drop `HEAD` from the `git diff` to audit the working tree instead.)

## 4. Load project context and the check command

```bash
find "$repo_root" -maxdepth 3 \( -name "CLAUDE.md" -o -name "AGENTS.md" \) \
  -not -path "*/node_modules/*" -not -path "*/target/*"
```

Keep the paths for `docsPaths`. Discover the project's check command exactly as
`/review-loop` step 3 does (declared in the docs or a task-runner target) and
record it as `check_cmd`; if none is declared, leave it empty and skip the check
steps. The engine's "author description" is the audit intent: `"Full audit of
SCOPE: assess correctness, security, concurrency, and maintainability of the
standing code."`

## 5. Run the review engine

Run the shared engine (`review-core` steps 1–7) with these contract inputs:

| Contract input          | Value for audit                                                        |
| ----------------------- | --------------------------------------------------------------------- |
| `out_dir`, `{DIFF_PATH}`, `{FILES_PATH}`, `{REPO_ROOT}` | from steps 3 (`$out_dir/diff.patch`, `$out_dir/files.txt`) |
| `{PROJECT_DOCS_PATHS}`  | the docs paths from step 4                                              |
| `{PR_DESCRIPTION}`      | the audit-intent sentence from step 4                                  |
| `{SOURCE_ACCESS}`       | `Read source files directly from the working tree, which is the code under audit.` |
| `{SCOPE_NOTE}`          | `This is a full audit, not a change review: the diff renders the entire scoped codebase as additions, so ALL of it is standing code under audit. "Pre-existing, on lines the diff did not modify" does not apply — everything shown is in scope.` |
| `{INSPECTOR_ARG}`       | empty string                                                          |
| `{REPORT_HEADER}`       | `# Audit — SCOPE\n**Repo:** REPO_ROOT\n**Commit:** HEAD_SHA\n**Files:** N\n**Size:** LOC lines` |
| `{TERMINAL_HEADER}`     | `Audit — SCOPE\nN files, LOC lines`                                   |
| `{SYNTHESIS_EXTRA}`     | empty string                                                          |
| `{INCLUDE_ATTRIBUTION}` | `true`                                                                |

**Chunk HARDER than a review — that is the whole point of audit-vs-review.** A
review sees a small diff; an audit sees the entire tree, so split aggressively for
maximum parallelism: aim for **~1,500-2,000 lines per chunk** (not review-core's
~3,500 review default), and give a single large file its own chunk rather than
bundling it. Group by crate / directory / feature so each chunk is coherent.
Generate each chunk's diff with the same empty-tree command plus a path filter,
duplicate the reviewer lanes per chunk, and run the **context-selected inspectors**
(review-core step 3 — only the languages actually present) once over the full
target. Pass ALL chunk lanes to one workflow invocation: the executor caps real
concurrency, but more, smaller chunks keep every slot busy and keep each reviewer
well within quality range. Scale up rather than down — a large repo wants dozens
of lanes, not a handful. Report the chunk plan first.

**Usage limits / native-only:** if step 1 lands on `native-only` (typical on
limit-blown days), batch workflow passes (~40 lanes each) for whole-repo audits.
Tell the user once; do not re-probe. `/review-pr`-scale diffs run one native-only
pass — five reviewers + inspectors is sufficient.

The engine writes `review.md` / `findings.json` and prints the summary. If
`findings` is empty, say the audit found nothing actionable and stop.

## 6. Triage

Triage the returned `findings` with `/review-loop`'s bias-to-fix table (severity
+ verdict + confidence → auto-fix / discuss / auto-dismiss). The verifier already
dropped invalid and out-of-scope findings. For an audit, **defer-by-default is
fine for low-value findings** — a whole-repo audit surfaces more than is worth a
PR; fix the ones that clearly should be fixed, and offer the rest as a list.

## 7. Plan the PRs and confirm

Cluster the fix-now findings into **coherent, independently reviewable PRs** —
group by crate/module/theme so each PR is small, revertable, and tells one story;
never one giant PR. Audit findings are usually unrelated, so default to
**independent sibling branches off trunk** (one PR each); use a stack only when a
fix genuinely depends on another.

Print the plan and **confirm before creating anything** (opening multiple PRs is a
large outward action — this is the one place to stop for input):

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Audit fix plan — <tool>  ·  <N> PRs off <trunk>
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  1. fix/settlement-rounding   crates/settlement   (2 findings: 1 critical, 1 high)
  2. fix/auth-check-admin      crates/api          (1 finding: high)
  ...
  Deferred (offered, not fixed): 6 lower-value findings
```

Use `AskUserQuestion` to confirm: create all, a subset, file the deferred ones as
issues instead, or stop. Do not create PRs until the user picks.

## 8. Open one PR per cluster

For each confirmed cluster (return to `trunk`/start between clusters):

1. **Branch off trunk.** GitButler: create a new virtual branch. Plain Git:
   `git checkout "$trunk"` then `git checkout -b <name>`.
2. **Apply the cluster's fixes** with `/review-loop`'s fix discipline: read the
   source, re-verify each finding against current code, apply a surgical fix, add
   or update tests where the project docs require coverage. Keep it to this
   cluster's files.
3. **Compile gate + delta re-review + check.** Run the fastest scoped typecheck,
   then `/review-loop`'s delta re-review over the fix, then `check_cmd` (skip if
   none) until green. Never open a PR whose fixes do not compile or fail the
   project check.
4. **Commit and open a DRAFT PR, assigned to you.** Commit the cluster. Then:
   - GitButler: `but push` the branch, then `gh pr create --draft`.
   - Plain git: `git push -u origin <name>`, then `gh pr create --draft`.
   Then `gh pr edit <number> --add-assignee @me` (PRs default to no assignee).
5. **PR description = Motivation / Solution** (the repo default), citing the
   audit findings it closes: file:line, severity, why it matters, and the fix.
   Keep it factual; no AI-process narration.

Open PRs as **drafts** so you review before they reach reviewers — never flip
draft to ready, never `--publish`, never merge, never override branch protection.

## 9. Return and summarize

Return to `start_branch` (plain Git: `git checkout`; GitButler: nothing to
restore). Print the summary:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Audit complete — <tool>  ·  <N> draft PRs opened
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  #123  fix/settlement-rounding   <url>   (closes 2 findings)
  #124  fix/auth-check-admin      <url>   (closes 1 finding)

Deferred (not fixed): 6 findings — say the word to file them as issues.
Full report: <path to review.md>
```

For deferred findings the user wants filed, use GitHub issues (`gh issue
create`), one issue per finding with a problem-only description. Show each
exact draft and obtain confirmation before creating it.

## Hard rules

1. **Opening PRs is this skill's purpose** (the user invoked `/audit`), but always
   as **drafts assigned to self**: never `--publish`, never flip draft to ready,
   never merge, never override branch protection. The user reviews and ships.
2. **Confirm the PR plan before creating any branch or PR.** Opening several PRs
   is a large outward action — stop for input on the plan (count, grouping).
3. **One coherent, small PR per cluster.** Never a single giant PR; group by
   crate/module/theme; default to independent sibling branches off trunk, stack
   only on real dependencies.
4. **Every PR compiles and passes `check_cmd` before it is opened.** Fixes are
   surgical and scoped to the cluster; re-verify each finding against current
   source first.
5. **Clean tree to start; never leak unrelated changes** into fix branches. Return
   to the start branch at the end.
6. The audit target is a synthetic diff against the empty tree — everything shown
   is in scope; "pre-existing/out of scope" never applies.
7. The review runs as a single `Workflow` invocation per pass (review-core) —
   never hand-roll the fan-out. External CLIs run read-only (review-core step 4):
   agy `--sandbox` and never `--dangerously-skip-permissions`.
8. **Filing deferred findings is gated**: show drafts, confirm, then create.
   Use GitHub issues with problem-only descriptions.
9. Never silently modify `.gitignore` — ask before adding `.tmp/` if missing.

## Failure modes

- **Dirty tree** — stop; fixes need clean branches off trunk.
- **Empty or unresolvable scope** — stop and ask; never fall back to the whole
  repo when a named scope failed to resolve.
- **Target large** — expected for a whole-repo audit; never a blocker. Chunk hard
  and proceed; a one-line heads-up is fine, but do NOT stop for confirmation on an
  unscoped audit. Scoping to a package is an optional cheaper follow-up the user
  may choose, not a gate.
- **A cluster's fix fails to converge or breaks the check command** — do not open
  that PR; report it, keep its findings in the deferred list, and continue with
  the other clusters.
- **All reviewer lanes error** — stop (review-core engine failure modes);
  inspector lanes erroring is non-fatal.
- **The workflow fails mid-run** — relaunch with `{scriptPath, args,
  resumeFromRunId}`; completed lanes return cached results.
- **Not a git repo / no trunk / no `gh`** — the branch+PR action needs them; tell
  the user what is missing instead of half-opening a PR.
- **GitButler not in workspace mode** — stop and ask the user to enter it; never
  switch modes yourself.
