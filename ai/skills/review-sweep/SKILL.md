---
name: review-sweep
user-invocable: true
allowed-tools: Bash(but:*), Bash(direnv:*), Bash(git:*), Bash(gh:*), Bash(agy:*), Bash(command:*), Bash(cargo:*), Bash(mkdir:*), Bash(cat:*), Bash(mktemp:*), Bash(rm:*), Bash(test:*), Bash(grep:*), Bash(wc:*), Bash(date:*), Bash(basename:*), Bash(find:*), Bash(ls:*), Read, Write, Edit, Agent, Workflow, AskUserQuestion, Skill
description: "Review an existing GitButler stack: fix owned branches and draft inline findings on others. Plain Git uses single-branch review."
argument-hint: "[--start BRANCH] [--end BRANCH]"
---

Sweep an entire stack with the multi-model review panel, **parallelized**, and
dispatching per **authorship**.

**Default scope is the WHOLE stack.** Invoked with no arguments, the sweep covers
every branch in the applied GitButler series, across all applied stacks.
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
the *mutations* (applying fixes and absorbing them into managed series) must respect
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

| Adapter operation      | GitButler managed main worktree                                                     |
| ---------------------- | ----------------------------------------------------------------------------------- |
| detect                 | common Git directory has GitButler state and current top-level is the main worktree |
| ready check            | verified main worktree on a workspace branch; `but status` succeeds                 |
| enumerate with parents | each applied stack's series, base to tip                                            |
| scope a branch         | Git diff between verified parent/head SHAs                                          |
| navigate               | none; virtual branches are applied together                                         |
| absorb fixes           | `but absorb <branch>` after an inspected dry-run                                    |
| return to start        | none                                                                                |

---

## 1. Detect the stacking tool

```bash
repo_root=$(git rev-parse --show-toplevel)
git_common_dir=$(git rev-parse --path-format=absolute --git-common-dir)
main_root=$(git worktree list --porcelain | sed -n 's/^worktree //p' | head -n1)
if [ "$repo_root" != "$main_root" ]; then tool=none
elif [ -d "$git_common_dir/gitbutler" ]; then
  current_branch=$(git symbolic-ref --quiet --short HEAD) || {
    echo "Cannot establish the current branch; stop before choosing a workflow."
    exit 1
  }
  case "$current_branch" in
    gitbutler/*) tool=gitbutler ;;
    *) tool=none ;;
  esac
else tool=none
fi
echo "stacking tool: $tool"
```

Prefer GitButler only in an existing managed main worktree. A linked,
isolated, or scratch worktree uses plain Git and must not run even a GitButler
readiness probe. Explicit repository-local instructions may select a different
workflow rather than these shared defaults.

If `tool=none`, stop: this repo has no stacking tool, so there is no stack to
sweep. Tell the user to use `/review-loop` on the single branch instead.

Run the remaining GitButler steps only after verifying the managed main
worktree. They do not apply to linked or otherwise plain-Git worktrees.

## 2. Parse `--start` / `--end`

`$ARGUMENTS` may contain `--start <branch>` and/or `--end <branch>` (order
irrelevant; either may be absent). Reject any other token. Branch names are
resolved against the live stack in step 4 — a name not in the stack is a hard
error there.

Semantics across the applied GitButler stacks:

- **neither (the default)** — keep every branch in every applied series.
- **`--start S`** — keep `S` through the tip of its applied series.
- **`--end E`** — keep the bottom branch through `E` in its applied series.
- **both** — keep the inclusive range `S → … → E` in one applied series.
  Reject bounds in different series or with `E` before `S`; never cross stacks.

When a bound is supplied, exclude other series. With no bounds, do not filter
out any applied series. Resolve names and order from current metadata.

## 3. Preflight

Common: confirm the review tooling is available exactly as `/review-loop` step
1 requires, then resolve review-core step 1 once for the whole sweep. Use the
native Luna lanes for every branch and add at most one read-only Claude Code
subscription lane when available. Cursor remains retired; never probe or launch
it mid-sweep.

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

**[GitButler]** Enumerate with JSON so you never parse the human graph:

```bash
but status -j        # applied stacks and their series
but branch list -j   # all branches; confirm field names with `but branch list -h`
```

Each applied stack's series is ordered base → tip. Resolve the stack's base SHA
from current GitButler metadata and verify it with Git; do not guess a trunk.
A branch's parent is the preceding series entry, or that verified base SHA for
the bottom branch. Missing or ambiguous base/head identity blocks that branch.
Use step 2's range rules: no bounds keeps all applied series; supplied bounds
select and trim exactly one series after validating both names and their order.

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
  bases: <verified stack bases>      range: <start or ⊥> → <end or top>
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  1. feat/a       (parent: <verified base SHA>)
  2. feat/a-x      (parent: feat/a)
  3. feat/a-y      (parent: feat/a)
  ...
```

If the resolved range is genuinely empty (e.g. no applied branches),
there is nothing to do — say so and stop. That is not a confirmation; it is a
no-op.

## 5. Phase 1 — review every branch in parallel (read-only)

Reviewing is read-only, so do it for **all** branches at once, before mutating
anything. Nothing here checks out a branch or edits a file.

1. **Scope each branch by SHA (no checkout).** For every branch, write its diff
   and manifest into its own `out_dir` (`…/reviews/<ts>-sweep/<safe_branch>/`):
   - Save the exact parent/head SHA diff and file manifest. Reviewers read
     committed source via `git show <branch_sha>:<path>` rather than attributing
     the combined applied workspace to a single branch.
   - Use `but branch show <branch>` to inspect branch metadata, not as a patch
     or source substitute. Generate `diff.patch` and the name-status manifest
     from the resolved parent/head Git SHAs. The combined working tree is not
     source evidence for an individual branch.

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
   except `{SOURCE_ACCESS}` is the committed SHA form above so no checkout is
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
absorbing a parent fix can restack descendants in the managed main worktree).
For each branch:

1. **Refresh if a downstack fix moved this branch.** If an already-processed
   ancestor was modified after phase 1 (so this branch was restacked), its
   phase-1 findings are against the pre-restack diff. Run a **delta re-review**
   (`/review-loop` step 9 delta workflow) over just the restack delta and merge
   any new findings with the phase-1 set. If nothing downstack changed this
   branch, use the phase-1 findings as-is. Either way, `/review-loop`'s fix step
   re-verifies every finding against the current source before touching it, so
   stale line numbers from a restack are caught.

2. **Triage + fix + converge** = `/review-loop` steps 5–9 on this branch:
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

The Defer-to-GitHub step (`/review-loop` step 10) still applies per branch when
the user explicitly defers a finding.

## 7. Return and summarize

The managed main workspace needs no checkout restoration: all series remained
applied throughout the sweep.

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

- For each modified branch, resolve its current branch name from the recorded
  series and use `but push <branch-name>`. Never use bare `but push`: in
  non-interactive mode it pushes all branches. Before each push, verify the
  selector and effective remote scope match the reviewed modified branch;
  if the installed version's selector semantics differ, inspect its help and
  stop rather than broaden the push.

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
   (absorbing fixes and the working-tree edits needed in the managed main workspace) run
   parent-before-child. Reviewer mode has no mutations, so it is parallel
   end-to-end.
2. **Parent before child for mutations, always.** A branch is fixed and modified
   before any of its children, so every child is fixed on top of its parent's
   fixes. Follow the verified GitButler series order.
3. **Upstack delta re-reviews are expected.** When a downstack fix restacks a
   branch, re-review only the restack delta (cheap), not a fresh full panel — this
   is the accepted cost of the parallel head-start.
4. **Modify-and-advance is allowed (author mode).** Modifying each branch's fixes
   into its verified managed main-worktree series is expected — the same relaxation
   `/review-loop stack` makes.
5. **Push the fixes without changing PR state (author mode).** In the verified
   GitButler-managed main worktree, push only modified series using the scoped
   existing workflow. Never flip draft→ready, open a new PR, post/resolve/react
   to PR comments, or override branch protection. Inspect the intended branch
   and remote scope before pushing; an existing approval is not permission to
   update unrelated branches.
6. **Never change the VCS's mode or topology.** No setup/teardown, branch creation,
   deletion, reparenting, reordering, or merging a branch into its parent. A
   descendant restack caused by absorbing a verified fix is expected, but it
   does not authorize changing which branches belong to the stack.
7. **Stop the sweep on a stuck branch.** Never descend into the children of a
   branch that failed to converge — their scope is built on unsettled code.
8. **Per branch, the shared engine owns the review.** Each panel is `review-core`
   (single `review-panel` Workflow, verify + synthesize inside it, read-only
   external CLIs — `--sandbox` and never `--dangerously-skip-permissions` for
   agy). The per-branch action is
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
- **Un-absorbed workspace changes** — stop; a
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
