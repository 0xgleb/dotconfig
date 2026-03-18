---
name: worktree
description: Manage git worktrees with create, submodules, and verify subcommands
user-invocable: true
allowed-tools:
  - "Bash(git *)"
  - "Bash(gt init *)"
  - "Bash(mkdir *)"
  - "Bash(rm -rf *)"
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

## Usage

```
/worktree                # Auto-detect situation and resolve (smart mode)
/worktree create         # Create a new worktree from main branch
/worktree submodules <path>  # Fix submodules in an existing worktree
/worktree verify         # Check if .worktrees/ paths match branch names
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
   - Run `verify` to check all worktrees for issues
   - Suggest creating a new worktree if none exist
   - List any existing worktrees and offer to create another

3. **If in a worktree:**
   - Check if submodules are broken:
     - Look for broken symlinks in `lib/`
     - Try to resolve a submodule path (e.g., `lib/some-sub/Cargo.toml`)
     - If broken or unreachable, suggest `submodules`
   - Check if `.worktrees/path/to/name` matches current branch name:
     - Extract expected path from branch (e.g., `feat/auth` →
       `.worktrees/feat/auth`)
     - If mismatch, report and suggest moving worktree
   - If no issues detected, report status: ✓ worktree is healthy

4. **If ambiguous or multiple issues:**
   - Ask user which action to take with explicit options

### Steps

1. **Determine location:**
   ```bash
   git_dir=$(git rev-parse --git-dir)
   common_dir=$(git rev-parse --git-common-dir)
   is_worktree=$([ "$git_dir" != "$common_dir/.git" ] && echo true || echo false)
   ```

2. **If main repo:** Run `verify` subcommand steps and suggest next action

3. **If worktree:**
   - Get current branch: `git rev-parse --abbrev-ref HEAD`
   - Get worktree path: extract from `git worktree list`
   - Check for broken submodules by attempting to list files in `lib/`
   - If any issues found, recommend the appropriate fix
   - If all healthy, report success and offer to open the worktree or run a
     build check

## Subcommands

### create

Create a new git worktree from the main branch of the current repository.

#### Steps

1. **Ask the user for the worktree name.** Suggest today's date (`YYYY-MM-DD`)
   as the default. If the user accepts the default or provides no name, use the
   date.

2. **Resolve paths:**
   - Main repo root: run `git rev-parse --git-common-dir` and strip the `/.git`
     suffix. This gives the main repo root whether you're in the main repo or an
     existing worktree.
   - Main branch: run
     `git symbolic-ref refs/remotes/origin/HEAD | sed 's|refs/remotes/origin/||'`
     to detect it (e.g., `master` or `main`).
   - Worktree path: `<main-repo-root>/.worktrees/<name>`.

3. **Create the worktree container directory** if it doesn't exist:
   ```bash
   mkdir -p <main-repo-root>/.worktrees
   ```

4. **Fetch latest main branch** and **create the worktree** (run git commands
   from the main repo root):
   ```bash
   git -C <main-repo-root> fetch origin <main-branch>
   git -C <main-repo-root> worktree add <worktree-path> origin/<main-branch>
   ```

5. **Initialize Graphite** in the new worktree. First check the current trunk
   from the CLI in the main repo:
   ```bash
   gt trunk
   ```
   Use that value as `<trunk>`, then initialize in the worktree:
   ```bash
   cd <worktree-path> && gt init --trunk <trunk>
   ```

6. **Fix submodule symlinks** (only if `lib/` exists in the main repo):
   ```bash
   fix-worktree-submodules <worktree-path>
   ```
   This nushell command handles everything: creates a real `lib/` directory with
   individual relative symlinks to each submodule, computes the correct `../`
   depth dynamically, and marks entries as assume-unchanged.

7. **Allow direnv** and wait for the nix shell to initialize (only if a `.envrc`
   file exists in the worktree):
   ```bash
   cd <worktree-path> && direnv allow
   ```
   Then run a command that forces direnv to load the environment:
   ```bash
   cd <worktree-path> && direnv exec <worktree-path> true
   ```
   Wait for it to complete. This ensures the nix shell is fully built before
   proceeding.

8. **Reset the SQLite database** (only if `sqlx` is available and the project
   uses it -- check for a `migrations/` directory):
   ```bash
   cd <worktree-path> && direnv exec <worktree-path> sqlx db reset -y
   ```

9. **Report** the worktree path and confirm it's ready to use.

### submodules

Fix broken submodules in an already-created worktree. Run this if submodule
symlinks are missing or broken, or if `cargo check` fails with "No such file or
directory" on Cargo.toml paths.

**Arguments:** `<worktree-path>` — the path to the worktree (e.g.,
`.worktrees/feat/auth`)

#### Steps

1. Run the nushell command:
   ```bash
   fix-worktree-submodules <worktree-path>
   ```
2. **Report** what was fixed.

### verify

Check if the `.worktrees/` directory structure matches actual branch names. This
helps identify when worktree paths and branch names have diverged.

**Arguments:** none — scans all worktrees in the current repo

#### Steps

1. **Resolve the main repo root** using `git rev-parse --git-common-dir`.

2. **Check if `.worktrees/` exists.** If it doesn't, report that no worktrees
   exist.

3. **Find all worktrees** in `.worktrees/` (recursively, since nesting is
   allowed).

4. **For each worktree path:**
   - Extract the branch name:
     `git -C <worktree-path> rev-parse --abbrev-ref HEAD`
   - Compare it to the path structure (e.g., `.worktrees/feat/auth` →
     `feat/auth`)
   - If they match, mark as ✓
   - If they don't match, report the mismatch with the actual branch name

5. **Report a summary:**
   - List all worktrees and their status
   - For mismatches, show the expected path vs. the actual branch
   - Suggest moving the worktree if the user wants the path to match the branch
     (not automated — requires user decision)
