---
name: review-sweep
user-invocable: true
allowed-tools: Bash(gt:*), Bash(but:*), Bash(direnv:*), Bash(git:*), Bash(gh:*), Bash(cursor-agent:*), Bash(agy:*), Bash(command:*), Bash(linear:*), Bash(cargo:*), Bash(mkdir:*), Bash(cat:*), Bash(mktemp:*), Bash(rm:*), Bash(test:*), Bash(grep:*), Bash(wc:*), Bash(date:*), Bash(basename:*), Bash(find:*), Bash(ls:*), Read, Write, Edit, Agent, Workflow, AskUserQuestion, Skill
description: Sweep a whole stack in parallel, dispatching per authorship. With no arguments it sweeps the ENTIRE stack (every branch upstack of trunk) with no confirmation. On your OWN stack it runs /review-loop per branch (fix findings + fold in unaddressed PR feedback, modify into the branch, then submit). On SOMEONE ELSE's stack where you are the reviewer it runs /review-pr per branch (cross-review, post a draft batch of comments, never touch their code or submit a verdict). Detects the repo's stacking tool (Graphite or GitButler). Optional --start / --end bound the range.
argument-hint: "[--start BRANCH] [--end BRANCH]"
---

Sweep an entire stack with the multi-model review panel, **parallelized**, and
dispatching per **authorship**.

**Default scope is the WHOLE stack.** Invoked with no arguments, the sweep covers
every branch upstack of trunk — the full tree (Graphite) or forest (GitButler).
That is the default and it is unambiguous: **never ask the user to confirm the
scope or the branch count.** The invocation is the confirmation. `--start` /
`--end` narrow the range when the user wants less; absence of them means "all of
it", not "ask me".

**Authorship decides the per-branch action** (detected once, up front):

- **Author mode — your own stack** (you authored the PRs): `/review-loop` per
  branch — fix the findings, modify them into the branch, advance, submit the
  stack at the end.
- **Reviewer mode — someone else's stack** (you are the reviewer): `/review-pr`
  per branch's PR — cross-review and post a draft batch of comments for the
  author. NEVER modify their code, NEVER submit a verdict, NEVER push.

**Parallelism is the point.** The slow part of a sweep is the review panel, and
the panels are read-only — so the sweep reviews **every branch at once** before
it changes anything, instead of reviewing-then-fixing one branch at a time. Only
the *mutations* (applying fixes, `gt modify -a` / `but absorb`) must respect
parent-before-child order; the *reviews* do not. Upstack branches whose content
shifts when a downstack fix restacks them get a cheap **delta re-review** rather
than a fresh full panel. Net: far less wall-clock than the old branch-by-branch
serial loop, at the cost of some re-review work the user has explicitly accepted.

The review engine itself (panel, probes, prompts, the `review-panel` Workflow) is
the shared `~/.claude/skills/review-core/SKILL.md` that `/review-loop` and
`/review-pr` also use; the per-branch action around it is `/review-loop`'s (author)
or `/review-pr`'s (reviewer). This command adds only the traversal, the
parallelization, and the tool-specific scope/modify operations.

Follow these steps precisely.

---

## Architecture: adapter + engine + parallel orchestration

Three layers. Only the adapter is tool-specific.

- **Stack adapter** (tool-specific): detect the tool; enumerate the branches and
  their parent links; produce each branch's review scope **without mutating the
  tree** (SHA-range diff, no checkout); and modify a branch's fixes back into it.
- **Review engine** (tool-agnostic): the shared `review-core` panel turns one
  branch's diff into verified findings. The per-branch *action* is `/review-loop`'s
  fix loop (author) or `/review-pr`'s draft-comment flow (reviewer).
- **Parallel orchestration** (this command): resolve the range; run **all**
  per-branch panels concurrently (phase 1); then take the per-branch action
  (phase 2) — fully parallel in reviewer mode, dependency-ordered in author mode
  with delta re-reviews where a restack moved a branch.

| Adapter operation          | Graphite                                      | GitButler                                              |
| -------------------------- | --------------------------------------------- | ------------------------------------------------------ |
| detect                     | `.git/.graphite_repo_config` exists           | `.git/gitbutler/` exists                               |
| ready check                | working tree clean                            | on a `gitbutler/*` workspace branch (`but status` ok)  |
| enumerate (with parents)   | tree via `gt children` / `gt parent`          | each applied stack's series, base→tip                  |
| scope a branch (no mutate) | `git diff <parent_sha> <branch_sha>`          | `but branch show <branch>` (commits ahead of its base) |
| navigate (fix phase only)  | `gt checkout <branch>`                         | none — all virtual branches are applied at once        |
| modify fixes into a branch | `gt modify -a` (restacks descendants; NEVER `gt fold`) | `but absorb <branch>` (`--dry-run` first)     |
| return to start            | `gt checkout <start-branch>`                   | none                                                   |

---

## 1. Detect the stacking tool

```bash
repo_root=$(git rev-parse --show-toplevel)
if [ -f "$repo_root/.git/.graphite_repo_config" ]; then tool=graphite
elif [ -d "$repo_root/.git/gitbutler" ];          then tool=gitbutler
else tool=none
fi
echo "stacking tool: $tool"
```

(For a linked worktree, `$repo_root/.git` is a file pointing at the real git
dir — resolve it with `git rev-parse --git-common-dir` and look for the markers
there instead.)

If `tool=none`, stop: this repo has no stacking tool, so there is no stack to
sweep. Tell the user to use `/review-loop` on the single branch instead.

The rest of the command branches on `$tool`. Where a step says **[Graphite]** or
**[GitButler]**, run only the matching block.

## 2. Parse `--start` / `--end`

`$ARGUMENTS` may contain `--start <branch>` and/or `--end <branch>` (order
irrelevant; either may be absent). Reject any other token. Branch names are
resolved against the live stack in step 4 — a name not in the stack is a hard
error there.

Semantics, on a tree (Graphite) or forest (GitButler):

- **neither (the default)** — sweep every branch upstack of trunk. This is the
  full-stack default; proceed without any confirmation.
- **`--start S`** — sweep the subtree rooted at `S` (`S` and all its descendants).
- **`--end E`** — sweep only the ancestor path up to `E` (a single linear chain):
  bottom → `E`.
- **both** — sweep the path `S → … → E`. Error if `E` is not a descendant of `S`.

## 3. Preflight

Common: confirm the review tooling is available exactly as `/review-loop` step 1
requires, and run review-core step 1 (cache → two sentinels max → native-only
when composer is out). Run **once for the whole sweep** and reuse the cached
panel mode — never walk a long probe chain mid-sweep.
the resolved lanes for every branch's panel; re-resolve only if a lane hits a
usage limit mid-sweep.

**[Graphite]**

```bash
gt log short
git status --porcelain   # must be clean; a dirty tree pollutes every diff
```

If the tree is dirty, stop and tell the user (a real precondition, not a
scope question).

**[GitButler]** `but` is provided by the repo's flake/devenv. If `but` is not on
`PATH`, invoke it as `direnv exec "$repo_root" but …` for every `but` call below.
GitButler only operates in workspace mode:

```bash
but status >/dev/null 2>&1 || echo "not in workspace mode"
```

If `but status` fails with "Setup required" (or similar), **stop and tell the
user to enter GitButler workspace mode first**. Never run `but setup`/`but
teardown` or otherwise change GitButler mode yourself. Uncommitted, un-absorbed
changes that are not part of any branch are the GitButler equivalent of a dirty
tree; if `but status` shows them, stop and tell the user.

## 4. Resolve the sweep range and parent links

Produce `order` — the branches to sweep — **and each branch's parent**, so phase
2 can walk parent-before-child. Resolve SHAs for every branch now
(`git rev-parse <branch>`); phase 1 uses them to scope diffs without checking
anything out.

**[Graphite]** Determine the trunk and walk the tree with `gt children` /
`gt parent` (never `gt up` — ambiguous on a multi-child branch):

```bash
start_branch=$(git rev-parse --abbrev-ref HEAD)        # return here at the end
trunk=$(git symbolic-ref refs/remotes/origin/HEAD --short 2>/dev/null \
        | sed 's#^origin/##' || echo master)
```

- **`--end E` given** (linear path): from `E`, walk `gt parent` down to (and
  excluding) trunk — stopping at `S` if `--start S` is set — then reverse so it
  runs bottom → `E`. If `--start S` is set and `S` never appears, error: `E` is
  not a descendant of `S`.
- **no `--end`** (subtree / full tree): root at `S` (if given) else at trunk's
  children (`gt bottom` reaches one root; for a multi-root trunk, also visit
  trunk's other children). Build the full parent→child tree with `gt children`.
  Record every branch and its parent.

**[GitButler]** Enumerate with JSON so you never parse the human graph:

```bash
but status -j        # applied stacks and their series
but branch list -j   # all branches; confirm field names with `but branch list -h`
```

Each applied stack's series is ordered base → tip; a branch's parent is the
previous entry in its series (or trunk for the base). Default range = every
branch in every applied stack. Apply `--start`/`--end` by trimming each series;
drop stacks containing neither.

## 4.5 Determine the mode (author vs reviewer)

A stack has one author. Decide `mode` from the PR author of the branches in range
versus your own login:

```bash
me=$(gh api user --jq '.login')
author=$(gh pr view <a-branch-in-range> --json author --jq '.author.login' 2>/dev/null)
```

- No PR on any branch in range (local-only WIP) -> **author mode**.
- `author == $me` -> **author mode** (`/review-loop` per branch).
- `author != $me` -> **reviewer mode** (`/review-pr` per branch).
- **Mixed authors across the range** (rare) -> this is a genuine safety fork (fix
  your code vs comment on someone else's), not a scope question — stop and ask
  which mode. Never mix fix-and-comment in one sweep.

## 4.6 Print the plan and GO — no confirmation

Print the resolved plan, then **immediately proceed to step 5**. Do **not** ask
"sweep all N branches?", "this is a long run, continue?", or any other
scope/size confirmation — the user already chose the scope by invoking the
command (and by passing or omitting `--start`/`--end`). A large branch count is
information to print, never a gate.

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Review sweep — <tool>  ·  <author|reviewer> mode  ·  <N> branches (parallel)
  trunk: <trunk>      range: <start or ⊥> → <end or top>
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  1. feat/a        (parent: <trunk>)
  2. feat/a-x      (parent: feat/a)
  3. feat/a-y      (parent: feat/a)
  ...
```

If the resolved range is genuinely empty (e.g. no branches upstack of trunk),
there is nothing to do — say so and stop. That is not a confirmation; it is a
no-op.

## 5. Phase 1 — review every branch in parallel (read-only)

Reviewing is read-only, so do it for **all** branches at once, before mutating
anything. Nothing here checks out a branch or edits a file.

1. **Scope each branch by SHA (no checkout).** For every branch, write its diff
   and manifest into its own `out_dir` (`…/reviews/<ts>-sweep/<safe_branch>/`):
   - **[Graphite]** `git diff <parent_sha> <branch_sha> > "$out_dir/diff.patch"`
     and `git diff --name-status <parent_sha> <branch_sha> > "$out_dir/files.txt"`.
     Reviewers read source at the branch's commit via `git show <branch_sha>:<path>`
     (the working tree is not on this branch).
   - **[GitButler]** `but branch show <branch>` → `diff.patch` (+ name-status
     manifest). Reviewers read the working tree, which reflects the applied stack.

2. **Collect each branch's unaddressed PR feedback** (parallel with the panels;
   author mode folds it into triage, reviewer mode ignores it — `/review-pr`
   handles comments). For a branch with a PR:
   ```bash
   pr_number=$(gh pr view <branch> --json number --jq '.number' 2>/dev/null)
   gh api graphql -f query='query($owner:String!,$repo:String!,$pr:Int!){
     repository(owner:$owner,name:$repo){pullRequest(number:$pr){
       reviewThreads(first:100){nodes{isResolved isOutdated path line
         comments(first:20){nodes{author{login} body}}}}}}}' \
     -F owner=<owner> -F repo=<repo> -F pr="$pr_number"
   ```
   Keep `isResolved == false` threads, plus top-level review/issue comments that
   request concrete changes with no follow-up. Each becomes a finding candidate
   (file/line + the ask + inferred severity). If a branch has no PR or `gh` is
   unreachable, note "feedback not checked" and continue with panel findings.

3. **Run all panels concurrently.** Fire the `review-core` panel for every branch
   at the same time (each as its own Workflow run, launched together / in the
   background — reuse the lanes resolved in step 3, with each branch's own
   `diff.patch`, `{SOURCE_ACCESS}`, docs, and PR description). The executor caps
   real concurrency, but firing them together overlaps the slow external-CLI
   lanes and the verify phases across branches instead of serializing them.
   Collect each branch's verified `findings` + `review.md` as it completes; key
   them by branch. A branch whose panel fails mid-run is relaunched with
   `{scriptPath, args, resumeFromRunId}` (it does not block the others).

   Pass per-branch `review-core` contract inputs as `/review-loop` step 4 does,
   except `{SOURCE_ACCESS}` is the SHA form above (Graphite) so no checkout is
   needed, and (reviewer mode) `{SYNTHESIS_EXTRA}` + `{INCLUDE_ATTRIBUTION}=false`
   match `/review-pr`.

At the end of phase 1 you hold verified findings for every branch in range.

## 6. Phase 2 — act on the findings

### [Reviewer mode] — fully parallel, no ordering

Nothing mutates code, so there is no parent-before-child constraint. For each
branch, take its phase-1 findings and post a **draft batch of inline PR comments**
exactly as `/review-pr` does (pending review, never submitted; no AI references;
lowercase severity prefixes). The branches are independent — post their drafts
concurrently. Never modify code, never push, never submit a verdict. Then go to
step 7's reviewer summary.

### [Author mode] — ordered fix walk, fed by phase 1

Walk the branches **parent before child** (the only ordering constraint, because
`gt modify -a` / `but absorb` restacks descendants). For each branch:

1. **Refresh if a downstack fix moved this branch.** If an already-processed
   ancestor was modified after phase 1 (so this branch was restacked), its
   phase-1 findings are against the pre-restack diff. Run a **delta re-review**
   (`/review-loop` step 9 delta workflow) over just the restack delta and merge
   any new findings with the phase-1 set. If nothing downstack changed this
   branch, use the phase-1 findings as-is. Either way, `/review-loop`'s fix step
   re-verifies every finding against the current source before touching it, so
   stale line numbers from a restack are caught.

2. **Triage + fix + converge** = `/review-loop` steps 5–9 on this branch:
   - **[Graphite]** `gt checkout <branch>` (the fix phase mutates the working
     tree, so it is checked out here — unlike phase 1).
   - **[GitButler]** no checkout; edit in the applied workspace.
   - Fold the phase-1 PR-feedback candidates into the triage table alongside the
     panel findings (PR feedback gets a mild extra bias toward fixing — a human
     asked). Re-verify feedback against the current tree first; treat stale items
     as resolved and report them as such, don't re-fix.
   - Run the bias-to-fix triage, the **parallel fix-now pass** (`/review-loop`
     step 8 fix-fanout), the compile gate, and the delta-mode re-review loop until
     the branch returns a **clean** pass, then the project's declared `check_cmd`
     (skip if none). All of `/review-loop`'s hard rules apply, including the
     4-pass cap and "convergence requires a clean pass — never end on a fix."

3. **Modify the fixes into this branch** (only if files changed):
   - **[Graphite]** `gt modify -a` (via the `graphite` skill) — restacks
     descendants, so the children you reach next are already on the fixed parent.
   - **[GitButler]** `but absorb <branch>` (`--dry-run` first; confirm it targets
     only this branch's commits). For a fix that must land in one commit, `but
     amend <file> <commit>`.

4. **Stop the sweep on a stuck branch.** If a branch hits the 4-pass cap, stop —
   do **not** descend into its children (their scope is built on unsettled code).
   Report it and follow `/review-loop`'s non-convergence flow.

Independent subtrees (or independent GitButler stacks) have no ordering relation
to each other; process them in any order. They still mutate the one working tree,
so the fix walk itself is serial — but it is fed entirely by phase-1 reviews, so
no branch waits on another branch's panel.

The Defer-to-Linear step (`/review-loop` step 10) still applies per branch when
the user explicitly defers a finding.

## 7. Return and summarize

**[Graphite]** `gt checkout <start_branch>` to return to where the user was.
**[GitButler]** Nothing to restore.

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Review sweep complete — <tool>  ·  <author|reviewer> mode  ·  <N> branches
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  feat/a       converged clean (fixed 3 + 2 PR comments, modified)
  feat/a-x     converged clean (no changes; 1 PR comment already addressed)
  feat/a-y     stuck (4-pass cap — see above)   [sweep stopped here]

PR feedback dismissed as invalid (with reasons):
  feat/a  #12 "rename X" — factually wrong: X matches docs/domain.md

Reports under: <out_dir root>
```

**[Reviewer mode]** Nothing to submit — each branch already has its own draft
batch of comments. Summarize per PR (count of draft comments + link) so the user
can inspect and submit each review from the UI. Do not push, modify, or submit.
Every pending review must have an empty top-level body: never post a marker,
summary, verdict, reviewed-commit text, or any other PR-level review content.
Only verified inline findings belong in the draft.

**[Author mode]** Then **submit the fixes** — a stack of review fixes left local
is worthless. Submit once, at the end, from the start branch:

- **[Graphite]** `gt ss` (the sweep modified branches up and down the stack). When
  any *lower* PR is already **approved**, `gt submit --stack --dry-run` first and
  read the No-op vs Update labels so you know which approvals the resubmit
  disturbs. A No-op everywhere means it is already pushed — say so, don't re-push.
- **[GitButler]** `but push` the series you modified.

Submitting is NOT publishing. Never `--publish`, never flip draft→ready, never
open a NEW PR, never post/resolve/react to PR comments or otherwise change review
state, and never override branch protection. If nothing was modified, there is
nothing to submit — say so and stop.

---

## Hard rules

**No scope confirmation, ever.** No arguments means the whole stack; that is
unambiguous. Never ask the user to confirm the branch count or the range — print
the plan and proceed. The only stops are genuine preconditions (dirty tree,
GitButler not in workspace mode, mixed authorship) and a stuck branch — never
"are you sure you want all of them?".

**Mode dispatch first.** Author mode (your own stack) fixes + modifies + submits;
reviewer mode (someone else's stack) only cross-reviews and posts draft comments,
and NEVER modifies, pushes, or submits on a stack you don't own. Every
modify/submit rule below is **author-mode only**.

1. **Reviews are parallel; mutations are ordered.** Phase 1 reviews every branch
   concurrently (read-only, SHA-scoped, no checkout). Only phase-2 mutations
   (`gt modify -a` / `but absorb`, and the working-tree edits they need) run
   parent-before-child. Reviewer mode has no mutations, so it is parallel
   end-to-end.
2. **Parent before child for mutations, always.** A branch is fixed and modified
   before any of its children, so every child is fixed on top of its parent's
   fixes. Use `gt children` (never `gt up`) for Graphite trees; the series order
   for GitButler.
3. **Upstack delta re-reviews are expected.** When a downstack fix restacks a
   branch, re-review only the restack delta (cheap), not a fresh full panel — this
   is the accepted cost of the parallel head-start.
4. **Modify-and-advance is allowed (author mode).** Modifying each branch's fixes
   into it (`gt modify -a` / `but absorb`) is expected — the same relaxation
   `/review-loop stack` makes.
5. **Submit the fixes; do not publish (author mode).** Push so fixes reach the PRs
   (`gt ss` / `but push`), but never `--publish`, flip draft→ready, open a NEW PR,
   post/resolve/react to PR comments, or override branch protection. When lower
   PRs are already approved, `gt submit --stack --dry-run` first.
6. **Never change the VCS's mode or topology.** No `gt init`, no `but setup`/`but
   teardown`, no creating/deleting/reparenting/reordering branches. NEVER `gt
   fold` (it merges a branch into its parent). `gt modify -a` restacking
   descendants is an expected side effect, not a topology change.
7. **Stop the sweep on a stuck branch.** Never descend into the children of a
   branch that failed to converge — their scope is built on unsettled code.
8. **Per branch, the shared engine owns the review.** Each panel is `review-core`
   (single `review-panel` Workflow, verify + synthesize inside it, read-only
   external CLIs — `--mode plan` for cursor-agent, `--sandbox` and never
   `--dangerously-skip-permissions` for agy). The per-branch action is
   `/review-loop`'s fix loop (author) or `/review-pr`'s draft flow (reviewer). Do
   not hand-roll the fan-out or relax those rules.
9. **GitButler workspace mode is a precondition, not something you create.** If
   `but status` fails, stop and tell the user; never switch onto/off the
   `gitbutler/*` branch yourself.
10. **`--start` / `--end` resolve against the live stack.** A name not in the
    stack, or `--end` not a descendant of `--start`, is a hard error — never
    silently sweep a different range than asked.
11. **PR feedback is read-only on the PR side.** Author mode folds reviewer
    feedback into code; never reply to, react to, or resolve threads, never
    comment, never touch review state. Reviewer mode posts a draft batch (pending,
    never submitted). Re-verify each feedback item against the current tree before
    fixing — the sweep rebases as it climbs, so feedback may be moot.

## Failure modes

- **`tool=none`** — no stack to sweep; tell the user to run `/review-loop`.
- **Dirty tree (Graphite) / un-absorbed workspace changes (GitButler)** — stop; a
  dirty workspace pollutes every per-branch diff. (Precondition, not a scope ask.)
- **GitButler not in workspace mode** — stop and tell the user to enter it.
- **Empty resolved range** — nothing to do; say so and stop (a no-op, not a
  confirmation).
- **A branch fails to converge (4-pass cap)** — stop the sweep on that branch, do
  not descend, report it.
- **A panel fails mid-run** — relaunch that branch's panel with `{scriptPath,
  args, resumeFromRunId}` (per `review-core`'s engine failure modes); the other
  branches' panels keep running.
- **`but` not on PATH** — fall back to `direnv exec "$repo_root" but …`; if that
  also fails, stop and tell the user the flake dev shell isn't loaded.
- **`gh` unreachable or branch has no PR** — skip the feedback step for that
  branch (panel findings only) and mark it "feedback not checked" in the summary.
- **User says "stop" mid-sweep** — finish modifying the current branch if a modify
  is already in flight (never leave a half-applied fix), then stop and print the
  summary of branches done so far.
