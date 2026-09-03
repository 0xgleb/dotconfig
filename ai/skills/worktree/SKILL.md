---
name: worktree
description: Use `/worktree` only when a concrete isolation requirement justifies creating, inspecting, verifying, repairing, or immediately disposing a standardized git worktree; do not use it for ordinary work, branch, PR, Graphite, or GitButler navigation.
user-invocable: true
allowed-tools:
  - "Bash(git *)"
  - "Bash(gt init *)"
  - "Bash(mkdir *)"
  - "Bash(fix-worktree-submodules *)"
  - "Bash(ln -sfn *)"
  - "Bash(ls *)"
  - "Bash(direnv *)"
  - "Bash(cd *)"
  - "Bash(date *)"
  - "Bash(find *)"
  - AskUserQuestion
---

# Worktree Skill

Manage git worktrees with multiple subcommands.

## VCS Routing Invariant

GitButler operates only in the repository's main worktree. Inside every linked, isolated, scratch, or otherwise non-main worktree, use plain Git for reads and writes and never probe or initialize GitButler. For Graphite-managed repositories, Graphite CLI remains valid in both the main worktree and linked worktrees. Detect topology before selecting a backend; the parent repository's GitButler state does not make a linked worktree GitButler-capable.

## Worktree necessity and ownership

The assigned checkout is the default workspace. Do not inspect, enter, modify,
build in, or create another worktree merely because one exists, because the
current checkout is dirty, or as routine setup. Use another worktree only for a
concrete isolation or concurrency requirement that cannot safely be met in the
assigned checkout.

When one is necessary, use a stable repository-local role slot:

- reusable owner-managed slots: `.worktrees/secondary`,
  `.worktrees/tertiary`, and so on;
- exceptional disposable slots: `.tmp/worktrees/secondary`,
  `.tmp/worktrees/tertiary`, and so on.

Never create PR-, ticket-, branch-, timestamp-, date-, experiment-, or task-named
worktree directories. A disposable one-off worktree is allowed only when the
operation genuinely needs it, and it must use the first available standardized
role slot rather than a descriptive ad hoc path.

The clanker or agent that creates a worktree owns its full lifecycle. Remove its
Git worktree registration, generated outputs, and directory immediately after
the isolated operation succeeds, fails, or is cancelled. A pre-existing
owner-managed role slot may remain. A worktree created by the current agent may
remain only when the owner explicitly asks to retain it. If cleanup is unsafe,
record the exact path and blocker and make cleanup the first resumed action;
never silently leave it for the owner or another agent.

## Usage

```
/worktree                     # Inspect only the current workspace by default
/worktree create              # Create a standardized slot when isolation is required
/worktree dispose <path>      # Immediately remove an agent-created worktree
/worktree submodules <path>   # Fix submodules in an existing worktree
/worktree verify              # Verify standardized worktree slots
```

## Smart Mode (No Subcommand)

When no subcommand is provided, automatically detect the current situation and
recommend or resolve as appropriate.

### Detection Logic

1. **Detect if we're in a worktree or main repo:**
   - Check if `git rev-parse --git-common-dir` differs from the current `.git`
     location
   - If in a worktree, get the worktree path and branch name

2. **If in main repo:**
   - Inspect only the current workspace unless the user asked to inventory or
     verify other worktrees.
   - Do not suggest or create a worktree without a concrete isolation need.
   - If isolation is required, run `verify` before selecting the first available
     standardized role slot.

3. **If in a worktree:**
   - Select plain Git for all non-Graphite VCS operations; never run GitButler there.
   - Inspect only the current worktree, not its siblings.
   - Verify that its path is a standardized role slot under `.worktrees/` or
     `.tmp/worktrees/`. A role-slot path is intentionally independent of the
     current branch name.
   - Check submodules only when the active task needs them. If required links are
     broken or unreachable, suggest `submodules`.
   - Determine whether the slot predates the current agent. If the current agent
     created it, keep its mandatory `dispose` action active.

4. **If ambiguous or multiple issues:**
   - Ask user which action to take with explicit options

### Steps

1. **Determine location:**

   ```bash
   git_dir=$(git rev-parse --git-dir)
   common_dir=$(git rev-parse --git-common-dir)
   is_worktree=$([ "$git_dir" != "$common_dir/.git" ] && echo true || echo false)
   ```

2. **If main repo:** Report the current workspace status. Run `verify` only
   when the user requested worktree inventory or a concrete isolation need
   requires choosing a slot.

3. **If worktree:**
   - Get current branch: `git rev-parse --abbrev-ref HEAD`.
   - Get the current worktree path from `git worktree list` without entering or
     inspecting siblings.
   - Verify its standardized role-slot location and ownership.
   - Check submodules or run builds only when required by the active task.
   - If the current agent created the slot, keep cleanup pending until `dispose`
     verifies removal.

## Subcommands

### create

Create a standardized git worktree only when the current task has a concrete
isolation requirement.

#### Steps

1. **Confirm necessity and lifecycle.** State why the assigned checkout cannot
   safely perform the operation. If there is no concrete reason, do not create a
   worktree. Decide whether the slot is owner-managed/reusable or disposable;
   disposable is the default for a one-off isolated operation.

2. **Resolve paths:**
   - Main repo root: run `git rev-parse --git-common-dir` and strip the `/.git`
     suffix. This gives the main repo root whether you're in the main repo or an
     existing worktree.
   - Main branch: run
     `git symbolic-ref refs/remotes/origin/HEAD | sed 's|refs/remotes/origin/||'`
     to detect it (e.g., `master` or `main`).
   - Select the first available role name from `secondary`, `tertiary`, and so
     on. Never derive the directory name from a PR, ticket, branch, date,
     timestamp, experiment, or task.
   - Reusable path: `<main-repo-root>/.worktrees/<role>`.
   - Disposable path: `<main-repo-root>/.tmp/worktrees/<role>`.

3. **Create only the selected container directory** if it does not exist:

   ```bash
   mkdir -p <main-repo-root>/.worktrees
   # or, for a disposable slot:
   mkdir -p <main-repo-root>/.tmp/worktrees
   ```

   Record exact artifact provenance for a disposable slot immediately.

4. **Fetch only when the task requires current remote state**, then create the
   worktree from the required base (run Git from the main repo root):

   ```bash
   git -C <main-repo-root> fetch origin <main-branch>
   git -C <main-repo-root> worktree add <worktree-path> origin/<main-branch>
   ```

5. **Initialize only what the isolated task actually needs.** Initialize
   Graphite only in a Graphite repository when the task needs Graphite. Repair
   submodules only when the task reads or builds them. Allow direnv or initialize
   databases only when the task requires that environment. Do not eagerly create
   caches, build outputs, profiles, or databases as generic worktree setup.

6. **Register cleanup before doing the isolated work.** The creating agent owns
   cleanup on success, failure, cancellation, or interruption. For a disposable
   slot, invoke `dispose` as soon as the isolated result has been copied or
   committed back and verified. For a reusable slot created by the current
   agent, also invoke `dispose` before completion unless the owner explicitly
   asked to retain it.

7. **Report** the exact path, why isolation was required, and the cleanup plan.

### dispose

Immediately remove an agent-created worktree after its isolated operation ends.

**Arguments:** the exact standardized worktree path.

#### Steps

1. Verify that the path is the exact worktree created by the current agent and
   is under `.worktrees/<role>` or `.tmp/worktrees/<role>`. Do not dispose a
   pre-existing owner-managed worktree.
2. Verify that required changes or evidence have been transferred and that no
   uncommitted user work would be lost. If cleanup is unsafe, persist the exact
   path and reason as a blocker and stop before mutation.
3. Remove the registration from the main repository:
   ```bash
   git -C <main-repo-root> worktree remove <exact-worktree-path>
   git -C <main-repo-root> worktree prune
   ```
4. Remove only exact remaining generated outputs covered by the creating agent's
   artifact provenance, then forget that provenance. Never use a parent path,
   wildcard, or unrelated cleanup operand.
5. Verify that the exact path and its worktree registration are gone. Cleanup is
   part of task completion, not deferred housekeeping.

### submodules

Fix broken submodules in an already-created worktree. Run this if submodule
symlinks are missing or broken, or if `cargo check` fails with "No such file or
directory" on Cargo.toml paths.

**Arguments:** `<worktree-path>` — the standardized worktree path (for
example, `.worktrees/secondary`).

#### Steps

1. Run the nushell command:
   ```bash
   fix-worktree-submodules <worktree-path>
   ```
2. **Report** what was fixed.

### verify

Inventory worktrees only when explicitly requested or when a concrete isolation
need requires selecting a free standardized slot. Branch names do not need to
match role-slot paths.

**Arguments:** none — inspects registered worktrees and the two approved
repository-local containers.

#### Steps

1. **Resolve the main repo root** using `git rev-parse --git-common-dir`.
2. Read registered paths from `git worktree list --porcelain`.
3. Inspect only immediate children of `<main-repo-root>/.worktrees/` and
   `<main-repo-root>/.tmp/worktrees/`; do not recursively crawl worktree
   contents or build outputs.
4. For each path, report:
   - whether it is registered;
   - whether its final component is a standardized stable role slot such as
     `secondary` or `tertiary`;
   - whether it is reusable or disposable based on its container;
   - whether current-session provenance proves the current agent created it and
     therefore owes cleanup.
5. Report unregistered directories and nonstandard ad hoc paths as cleanup
   candidates, but never delete them without exact ownership and safety
   evidence. Do not suggest adding another worktree when an appropriate free or
   reusable standardized slot already exists.
