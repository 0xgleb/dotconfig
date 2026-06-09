---
allowed-tools: Bash(gt:*), Bash(but:*), Bash(direnv:*), Bash(git:*), Bash(gh:*), Bash(codex:*), Bash(linear:*), Bash(cargo:*), Bash(mkdir:*), Bash(cat:*), Bash(mktemp:*), Bash(rm:*), Bash(test:*), Bash(grep:*), Bash(wc:*), Bash(date:*), Bash(basename:*), Bash(find:*), Bash(ls:*), Read, Write, Edit, Agent, Workflow, AskUserQuestion, Skill
description: Sweep the whole stack bottom-to-top, running the full /review-loop on each branch and folding the fixes into it before moving up. Detects the repo's stacking tool (Graphite or GitButler) and uses the right primitives. Optional --start / --end bound the range; otherwise it covers every branch upstack of the trunk. Graphite stacks are traversed as trees (parent before child); GitButler stacks as a forest of applied series.
argument-hint: [--start <branch>] [--end <branch>]
---

Sweep an entire stack with the self-review loop. For every branch upstack of
the trunk, run the full `/review-loop` single-branch procedure, fold the fixes
into that branch, then move up — so each branch is reviewed in the rebased
state its parent's fixes produced.

This is a strict generalization of `/review-loop stack`:

- `/review-loop stack` walks up from the **current** branch to the top, on
  Graphite only.
- `/review-sweep` starts at the **bottom** (just above trunk) by default,
  covers **every** branch upstack of trunk (the whole tree / forest, not just
  one path), bounds the range with `--start` / `--end`, and works on
  **Graphite or GitButler** by detecting which the repo uses.

The per-branch review work is identical to `/review-loop` and is **not**
re-specified here — this command only adds the stack traversal and the
tool-specific scope/fold operations around it.

Follow these steps precisely.

---

## Architecture: adapter + engine + orchestration

Three layers. Only the adapter is tool-specific.

- **Stack adapter** (tool-specific): detect the tool, enumerate the branches
  to sweep in parent-before-child order, produce the per-branch review scope
  (`diff.patch` + `files.txt`), and fold a branch's accumulated fixes back
  into that branch.
- **Review engine** (tool-agnostic): given a per-branch scope, run
  **`/review-loop` steps 3–12** — build the panel prompts, run the
  `review-panel` Workflow, triage, fix-now loop, compile gate, and the
  delta-mode re-review loop until the branch converges clean, then `/ci`. Do
  not re-implement any of that here; reuse it verbatim per branch.
- **Orchestration** (this command): resolve the range, drive the adapter over
  it branch by branch, return to the start, and print the per-branch summary.

| Adapter operation        | Graphite                                      | GitButler                                              |
| ------------------------ | --------------------------------------------- | ------------------------------------------------------ |
| detect                   | `.git/.graphite_repo_config` exists           | `.git/gitbutler/` exists                               |
| ready check              | working tree clean                            | on a `gitbutler/*` workspace branch (`but status` ok)  |
| enumerate (parent→child) | pre-order DFS via `gt children`               | each applied stack's series, bottom→top                |
| navigate to a branch     | `gt checkout <branch>`                         | none — all virtual branches are applied at once        |
| scope one branch's diff  | `git diff $(gt parent)`                        | `but branch show <branch>` (commits ahead of its base) |
| fold fixes into a branch | `gt modify -a` (amends + restacks descendants) | `but absorb <branch>` (`--dry-run` first)              |
| return to start          | `gt checkout <start-branch>`                   | none                                                   |

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
dir — resolve it with `git rev-parse --git-common-dir` and look for the
markers there instead.)

If `tool=none`, stop: this repo has no stacking tool, so there is no stack to
sweep. Tell the user to use `/review-loop` on the single branch instead.

The rest of the command branches on `$tool`. Where a step says **[Graphite]**
or **[GitButler]**, run only the matching block.

## 2. Parse `--start` / `--end`

`$ARGUMENTS` may contain `--start <branch>` and/or `--end <branch>` (order
irrelevant; either may be absent). Reject any other token. The branch names are
resolved against the live stack in step 4 — a name that is not in the stack is
a hard error there.

Semantics, on a tree (Graphite) or forest (GitButler):

- **neither** — sweep every branch upstack of trunk.
- **`--start S`** — sweep the subtree rooted at `S` (`S` and all its
  descendants).
- **`--end E`** — sweep only the ancestor path up to `E` (a single linear
  chain, since a branch's ancestors are unique): bottom → `E`.
- **both** — sweep the path `S → … → E`. Error if `E` is not a descendant of
  `S`.

## 3. Preflight

Common: confirm `codex` and the review tooling are available exactly as
`/review-loop` step 1 requires (drop the two codex lanes with a warning if
`codex` is missing).

**[Graphite]** Same preflight as `/review-loop`:

```bash
gt log short
git status --porcelain   # must be clean; a dirty tree pollutes every diff
```

If the tree is dirty, stop and tell the user.

**[GitButler]** `but` is provided by the repo's flake/devenv. If `but` is not
on `PATH`, invoke it as `direnv exec "$repo_root" but …` for every `but` call
below. GitButler only operates in workspace mode:

```bash
but status >/dev/null 2>&1 || echo "not in workspace mode"
```

If `but status` fails with "Setup required: Not currently on a gitbutler/*
branch" (or similar), **stop and tell the user to enter GitButler workspace
mode first** (check out the `gitbutler/*` workspace branch). Never run
`but setup`, `but teardown`, or otherwise change GitButler mode yourself —
that mutates their working state. Uncommitted, un-absorbed changes in the
workspace are the GitButler equivalent of a dirty tree; if `but status` shows
unstaged changes that are not part of a branch, warn and ask before
proceeding.

## 4. Resolve the sweep range (ordered, parent before child)

Produce `order` — the list of branches to sweep, each appearing **after** its
parent.

**[Graphite]** Determine the trunk and build a pre-order DFS frontier. Do not
use `gt up` (ambiguous when a branch has multiple children) — use
`gt children` (children of the *current* branch) and `gt parent`.

```bash
start_branch=$(git rev-parse --abbrev-ref HEAD)        # return here at the end
trunk=$(git symbolic-ref refs/remotes/origin/HEAD --short 2>/dev/null \
        | sed 's#^origin/##' || echo master)
```

- **`--end E` given** (linear path): from `E`, walk `gt parent` down to (and
  excluding) trunk — stopping at `S` if `--start S` is set — to get the chain,
  then reverse it so it runs bottom → `E`. If `--start S` is set and `S` never
  appears while walking down from `E`, error: `E` is not a descendant of `S`.
- **no `--end`** (subtree DFS): the frontier roots are `S` (if `--start S`),
  else trunk's children. Get a node's children by checking it out and reading
  `gt children`; get trunk's children by `gt checkout "$trunk"` then
  `gt children`. DFS pre-order: emit a node, then recurse into its children.
  The actual checkout + review + fold happens in step 5 as you visit each
  node; you do not need to pre-compute the full list, but you must always
  finish a node (review + fold) before descending into its children.

**[GitButler]** Enumerate with JSON so you never parse the human graph:

```bash
but status -j        # applied stacks and their series
but branch list -j   # all branches; confirm field names with `but branch list -h`
```

Read the JSON to get each **applied stack** and, within it, its **series** of
branches ordered base → tip (bottom → top). The default sweep is every branch
in every applied stack, each stack swept bottom → top. Apply `--start` /
`--end` by trimming each series to the requested sub-range; drop stacks that
contain neither. (If the JSON field names are unfamiliar, inspect them with
`but status -h` / `but branch list -h` before relying on them — do not guess.)

Print the resolved plan before sweeping:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Review sweep — <tool>  ·  <N> branches
  trunk: <trunk>      range: <start or ⊥> → <end or top>
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  1. feat/a        (parent: <trunk>)
  2. feat/a-x      (parent: feat/a)
  3. feat/a-y      (parent: feat/a)
  ...
```

If the range is empty, stop and say so. If it exceeds ~10 branches, warn the
user that this is a long, token-heavy run and ask whether to proceed.

## 5. Sweep loop

For each branch in `order` (parent before child), do one full pass:

1. **Scope the branch.**
   - **[Graphite]** `gt checkout <branch>`, then write the per-branch diff and
     manifest exactly as `/review-loop` step 2 does, diffing against
     `gt parent` (working-tree diff, no `..HEAD`, so re-review picks up
     uncommitted fixes). Give this branch its own `out_dir`
     (`…/reviews/<ts>-sweep/<safe_branch>/`).
   - **[GitButler]** No checkout — the branch is already applied. Get its diff
     from `but branch show <branch>` (its commits ahead of base) into
     `out_dir/diff.patch`, and a name-status manifest into `out_dir/files.txt`.
     Reviewers read source straight from the working tree, which already
     reflects the whole applied stack.

2. **Run the review engine = `/review-loop` steps 3–12** on this branch's
   scope: load project docs, build the panel prompts and inspector prompts, run
   the `review-panel` Workflow, print findings, triage with the bias-to-fix
   table, run the fix-now loop, the compile gate, and the delta-mode re-review
   loop until the branch returns a **clean** review pass, then `/ci`. All of
   `/review-loop`'s hard rules apply per branch, including the 4-pass cap and
   "convergence requires a clean pass — never end on a fix."

3. **Fold the fixes into this branch.** Only if the engine changed files:
   - **[Graphite]** `gt modify -a` (invoke the `graphite` skill). This amends
     the fixes into the branch's commit and restacks its descendants, so the
     children you descend into next are already rebased on the fixed parent.
   - **[GitButler]** `but absorb <branch>` to route the staged fixes into that
     branch's commits — run `but absorb <branch> --dry-run` first, confirm the
     plan targets only this branch's commits, then absorb. For a fix that must
     land in one specific commit, use `but amend <file> <commit>` instead.

4. **Advance.**
   - **[Graphite]** If `--end` mode (linear chain), move to the next branch in
     the precomputed chain. Otherwise (subtree DFS) read `gt children` of the
     branch you just folded and descend into each, unless this branch is the
     `--end` target (then prune — do not descend).
   - **[GitButler]** Move to the next branch in the series; when a series ends,
     start the next applied stack's series.

5. **Per-branch outcome.** Record: converged clean (and how many fixes), no
   changes, or **stuck** (hit the 4-pass cap). If a branch is stuck, stop the
   whole sweep — do **not** descend into its children, because their diffs are
   built on an unsettled parent. Report the stuck branch and follow
   `/review-loop`'s non-convergence flow.

The Defer-to-Linear step (`/review-loop` step 13) still applies per branch when
the user explicitly defers a finding.

## 6. Return and summarize

**[Graphite]** `gt checkout <start_branch>` to return to where the user was.
**[GitButler]** Nothing to restore — no navigation happened.

Then print the summary:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Review sweep complete — <tool>  ·  <N> branches
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  feat/a       converged clean (fixed 3, folded)
  feat/a-x     converged clean (no changes)
  feat/a-y     stuck (4-pass cap — see above)   [sweep stopped here]

Reports under: <out_dir root>
```

Then stop. Do **not** push or submit — the user decides when to publish.

---

## Hard rules

1. **Amend-and-advance is the whole point and is allowed**: folding each
   branch's fixes into it (`gt modify -a` / `but absorb`) is expected. This is
   the same relaxation `/review-loop stack` makes to `/review-loop`'s "never
   amend automatically" rule — scoped to folding review fixes into the branch
   they belong to.
2. **Never push, submit, or open/flip PRs.** No `gt submit`/`gt ss`, no
   `but push`, no `gh pr` state changes — not even at the end, not even if a
   branch converges clean. Publishing is always the user's explicit call.
3. **Never change the VCS's mode or topology.** No `gt init`, no `but setup` /
   `but teardown`, no creating/deleting/reparenting/reordering branches. The
   sweep reviews and folds within the existing stack; it never restructures it.
   (`gt modify -a` restacking descendants is an expected side effect of
   folding, not a topology change.)
4. **Parent before child, always.** A branch is reviewed and folded before any
   of its children, so every child is reviewed on top of its parent's fixes.
   Use `gt children` (never `gt up`) for Graphite trees; use the series order
   for GitButler.
5. **Stop the sweep on a stuck branch.** Never descend into the children of a
   branch that failed to converge — their scope is built on unsettled code.
6. **Per branch, `/review-loop` owns the review.** Every per-branch pass is
   `/review-loop` steps 3–12 verbatim (single `review-panel` Workflow, verify
   and synthesize inside the workflow, `--sandbox read-only` codex, 4-pass cap,
   clean-pass convergence). Do not hand-roll the fan-out or relax those rules.
7. **GitButler workspace mode is a precondition, not something you create.** If
   `but status` fails, stop and tell the user to enter workspace mode; never
   switch onto or off the `gitbutler/*` branch yourself.
8. **`--start` / `--end` resolve against the live stack.** A name not in the
   stack, or `--end` not a descendant of `--start`, is a hard error — never
   silently sweep a different range than asked.

## Failure modes

- **`tool=none`** — no stack to sweep; tell the user to run `/review-loop`.
- **Dirty tree (Graphite) / un-absorbed workspace changes (GitButler)** — stop
  and ask; a dirty workspace pollutes every per-branch diff.
- **GitButler not in workspace mode** — stop and ask the user to enter it.
- **A branch fails to converge (4-pass cap)** — stop the sweep on that branch,
  do not descend, report it.
- **The `review-panel` Workflow fails mid-run on a branch** — relaunch it with
  `{scriptPath, args, resumeFromRunId}` (per `/review-loop`), then continue the
  sweep from that branch.
- **`but` not on PATH** — fall back to `direnv exec "$repo_root" but …`; if that
  also fails, stop and tell the user the flake dev shell isn't loaded.
- **User says "stop" mid-sweep** — finish folding the current branch if a fold
  is already in flight (never leave a half-applied fix), then stop and print the
  summary of branches done so far.
