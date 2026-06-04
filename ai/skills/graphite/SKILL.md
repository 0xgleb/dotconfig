---
name: graphite
description: Work with Graphite (gt) for stacked PRs - creating, navigating, and managing PR stacks.
allowed-tools:
  - "Bash(gt *)"
  - "Bash(git add *)"
  - "Bash(git reset *)"
  - "Bash(git diff *)"
  - "Bash(git status *)"
  - "Bash(git stash *)"
  - "Bash(git checkout *)"
  - "Bash(git rebase *)"
  - "Bash(git branch *)"
  - "Bash(gh pr *)"
---

# Graphite Skill

Work with Graphite (`gt`) for creating, navigating, and managing stacked pull
requests.

## Quick Reference

| I want to...            | Command                              |
| ----------------------- | ------------------------------------ |
| Create a new branch/PR  | `gt create branch-name -m "message"` |
| Amend current branch    | `gt modify -m "message"`             |
| Navigate up the stack   | `gt up`                              |
| Navigate down the stack | `gt down`                            |
| Jump to top of stack    | `gt top`                             |
| Jump to bottom of stack | `gt bottom`                          |
| View stack structure    | `gt ls`                              |
| Submit stack for review | `gt submit --no-interactive`         |
| Rebase stack on trunk   | `gt restack`                         |
| Change branch parent    | `gt track --parent <branch>`         |
| Rename current branch   | `gt rename <new-name>`               |
| Move branch in stack    | `gt move`                            |

---

## What Makes a Good PR?

In roughly descending order of importance:

- **Atomic/hermetic** - independent of other changes; will pass CI and be safe
  to deploy on its own
- **Narrow semantic scope** - changes only to module X, or the same change
  across modules X, Y, Z
- **Small diff** - (heuristic) small total diff line count

**Do NOT worry about creating TOO MANY pull requests.** It is **always**
preferable to create more pull requests than fewer.

**NO CHANGE IS TOO SMALL:** tiny PRs allow for the medium/larger-sized PRs to
have more clarity.

Always argue in favor of creating more PRs, as long as they independently pass
build.

---

## Branch Naming Conventions

**CRITICAL: Always pass an explicit branch name to `gt create`.** Without one,
Graphite auto-generates names like `graphite-base/390` which are meaningless.
Never run `gt create -m "message"` alone — always
`gt create branch-name -m "message"`.

**DEFAULT: name branches `<type>/<kebab-description>`.** This is the user's
standing convention across all repos. `<type>` is the conventional-commit type
(`feat` | `fix` | `refactor` | `chore` | `docs` | `test` | `spec` | `ops`) and
the description is self-contained plain-English kebab-case that says what the
change does — e.g. `feat/drop-usdc-from-rebalancer`,
`refactor/queue-push-error-enum`, `test/chaos-alpaca-transient-5xx`. When
splitting one branch into a stack, each slice gets its own
`<type>/<description>` name; the shared feature word lives in the description,
not as a stack prefix.

If a repo's `AGENTS.md` / `CLAUDE.md` or its existing branches (`gt ls`,
`git branch -a`) show a *different* convention, match that instead — the repo's
own convention always wins over this default.

**DO NOT use `terse-stack-feature-name/terse-description-of-change`** (e.g.
`auth-bugfix/reorder-args`). That pattern is graphite's own doc default; the
user does not use it. It is mentioned here only so you recognize where it comes
from and avoid copying it — applying it to a repo that uses `<type>/<description>`
is a naming error.

---

## Creating a Stack

### Basic Workflow

1. Make changes to files
2. Stage changes: `git add <files>`
3. Create branch: `gt create branch-name -m "commit message"`
4. Repeat for each PR in the stack
5. Submit: `gt submit --no-interactive`

### Handle Untracked Branches (common with worktrees)

Before creating branches, check if the current branch is tracked:

```bash
gt branch info
```

If you see "ERROR: Cannot perform this operation on untracked branch":

**Option A (Recommended): Track temporarily, then re-parent**

1. Track current branch: `gt track -p main`
2. Create your stack normally with `gt create`
3. After creating ALL branches, re-parent your first new branch onto main:
   ```bash
   gt checkout <first-branch-of-your-stack>
   gt track -p main
   gt restack
   ```

**Option B: Stash changes and start from main**

1. `git stash`
2. `git checkout main && git pull`
3. Create new branch and unstash:
   `git checkout -b temp-working && git stash pop`
4. Proceed with `gt track -p main` and `gt create`

---

## Navigating a Stack

```bash
# Move up one branch (toward top of stack)
gt up

# Move down one branch (toward trunk)
gt down

# Jump to top of stack
gt top

# Jump to bottom of stack (first branch above trunk)
gt bottom

# View the full stack structure
gt ls
```

---

## Modifying a Stack

### Amend Current Branch

```bash
git add <files>
gt modify -m "updated commit message"
```

### Reorder Branches

Use `gt move` to reorder branches in the stack. This is simpler than trying to
use `gt create --insert`.

### Re-parent a Stack

If you created a stack on top of a feature branch but want it based on main:

```bash
# Go to first branch of your stack
gt checkout <first-branch>

# Change its parent to main
gt track --parent main

# Rebase the entire stack
gt restack
```

### Rename a Branch

```bash
gt rename new-branch-name
```

---

## Resetting Commits to Unstaged Changes

If changes are already committed but you want to re-stack them differently:

```bash
# Reset the last commit, keeping changes unstaged
git reset HEAD^

# Reset multiple commits (e.g., last 2 commits)
git reset HEAD~2

# View the diff to understand what you're working with
git diff HEAD
```

---

## Before Submitting

### Verify Stack is Rooted on Main

Before running `gt submit`, verify the first PR is parented on `main`:

```bash
gt ls
```

If the first branch has a parent other than `main`:

```bash
gt checkout <first-branch>
gt track -p main
gt restack
```

### Run Validation

After creating each PR, run appropriate linting, building, and testing:

1. Refer to the project's CLAUDE.md for specific commands
2. If validation fails, fix the issue, stage changes, and use `gt modify`

---

## Submitting and Updating PRs

### Submit the Stack

```bash
gt submit --no-interactive
```

### Update PR Descriptions

After submitting, use `gh pr edit` to set proper titles and descriptions.

**IMPORTANT:** Never use Bash heredocs for PR descriptions - shell escaping
breaks markdown tables, code blocks, etc. Instead:

1. Use the `Write` tool to create `/tmp/pr-body.md` with the full markdown
   content
2. Use `gh pr edit` with `--body-file`:

```bash
gh pr edit <PR_NUMBER> --title "stack-name: description" --body-file /tmp/pr-body.md
```

PR descriptions must include:

- **Stack Context**: What is the bigger goal of this stack?
- **What?** (optional for small changes): Super terse, focus on what not why
- **Why?**: What prompted the change? Why this solution? How does it fit into
  the stack?

**Example** (for a PR in a 3-PR stack adding a warning feature):

```markdown
## Stack Context

This stack adds a warning on the merge button when users are bypassing GitHub
rulesets.

## Why?

Users who can bypass rulesets (via org admin or team membership) currently see
no indication they're circumventing branch protection. This PR threads the
bypass data from the server to enable the frontend warning (PR 2) to display it.
```

---

## Troubleshooting

| Problem                                             | Solution                                                                           |
| --------------------------------------------------- | ---------------------------------------------------------------------------------- |
| "Cannot perform this operation on untracked branch" | Run `gt track -p main` first                                                       |
| Stack parented on wrong branch                      | Use `gt track -p main` then `gt restack`                                           |
| Need to reorder PRs                                 | Use `gt move`                                                                      |
| Conflicts during restack                            | Resolve conflicts, then `git rebase --continue`                                    |
| Want to split a PR                                  | Prefer `gt split` (see below). Fallback: reset commits and re-stage selectively.   |
| Need to delete a branch (non-interactive)           | `gt delete <branch> -f -q`                                                         |
| `gt restack` hitting unrelated conflicts            | Use targeted `git rebase <target>` instead (see below)                             |
| Rebase interrupted mid-conflict                     | Check if files are resolved but unstaged, then `git add` + `git rebase --continue` |

---

## Splitting a Branch with `gt split`

When a branch has accumulated too much for one PR, `gt split` slices it
into multiple branches that get stacked in order. Three modes:

| Mode                                | What it does                                                                                  | Interactive? |
| ----------------------------------- | --------------------------------------------------------------------------------------------- | ------------ |
| `gt split --by-commit` (`-c`)       | Pick split points between existing commits on the branch.                                     | Yes          |
| `gt split --by-hunk` (`-h`)         | Stage hunks into N new single-commit branches. Use when one big commit needs to be split.     | Yes          |
| `gt split --by-file -f <pathspec>`  | Extract files matching the pathspec into a NEW PARENT branch. Repeat `-f` for more patterns.  | **No**       |

### When `--by-file` works cleanly

Each file ends up in exactly one slice (no shared edits). Example: a
branch that touches `module-a.rs` and `module-b.rs` and you want each
as its own PR:

```bash
gt split --by-file -f 'src/module-a*'
# now current branch has only module-b; parent has module-a
```

### When you need `--by-hunk`

Any file appears in multiple slices (e.g. a single `flake.nix` has
changes spanning all your intended PRs). `--by-file` can't separate
hunks within a file — only `--by-hunk` can. **`--by-hunk` requires a
TTY**, so the user must drive the interactive prompt; you can't run it
non-interactively from an agent.

### Fallback when neither mode fits the split

If the split mixes hunk-level changes AND no TTY is available for
`--by-hunk`, the only path is manual reconstruction:

1. Save the full diff as a safety-net branch (`git branch
   refactor-snapshot`).
2. From the trunk, build each slice sequentially with `gt create`,
   editing the relevant files to match that slice's intended end
   state.
3. Verify each slice independently with the project's tooling
   (`nix flake show`, `cargo check`, `bun run check`, etc.) before
   stacking the next one.

Slow but reliable. Use only when `--by-file` and `--by-hunk` both
can't do the job.

---

## Advanced: Surgical Rebasing in Complex Stacks

In deeply nested stacks with many sibling branches, `gt restack` can be
problematic:

- It restacks ALL branches that need it, not just your stack
- Can hit conflicts in completely unrelated branches
- Is all-or-nothing - hard to be surgical

### When to Use `git rebase` Instead of `gt restack`

Use direct `git rebase` when:

- You only want to update specific branches in your stack
- `gt restack` is hitting conflicts in unrelated branches
- You need to skip obsolete commits during the rebase

### Targeted Rebase Workflow

```bash
# 1. Checkout the branch you want to rebase
git checkout my-feature-branch

# 2. Rebase onto the target (e.g., updated parent branch)
git rebase target-branch

# 3. If you hit conflicts:
#    - Resolve the conflict in the file
#    - Stage it: git add <file>
#    - Continue: git rebase --continue

# 4. If a commit is obsolete and should be skipped:
git rebase --skip

# 5. After rebase, use gt modify to sync graphite's tracking
gt modify --no-edit
```

### Recovering from Interrupted Rebase (Context Reset)

If a rebase was interrupted (e.g., Claude session ran out of context):

1. **Check status:**
   ```bash
   git status
   # Look for "interactive rebase in progress" and "Unmerged paths"
   ```

2. **Read the "unmerged" files** - they may already be resolved (no conflict
   markers)

3. **If already resolved, just stage and continue:**
   ```bash
   git add <resolved-files>
   git rebase --continue
   ```

4. **If still has conflict markers**, resolve them first, then stage and
   continue

### Deleting Branches from a Stack

```bash
# Delete a branch (non-interactive, even if not merged)
gt delete branch-to-delete -f -q

# Also delete all children (upstack)
gt delete branch-to-delete -f -q --upstack

# Also delete all ancestors (downstack)
gt delete branch-to-delete -f -q --downstack
```

**Flags:**

- `-f` / `--force`: Delete even if not merged or closed
- `-q` / `--quiet`: Implies `--no-interactive`, minimizes output

**After deleting intermediate branches**, children are automatically restacked
onto the parent. If you need to manually update tracking:

```bash
gt checkout child-branch
gt track --parent new-parent-branch
```
