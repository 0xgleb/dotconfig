---
name: worktree
description: Manage git worktrees with create, fix-submodules, and verify subcommands
user-invocable: true
allowed-tools:
  - "Bash(git *)"
  - "Bash(gt init *)"
  - "Bash(mkdir *)"
  - "Bash(rm -rf *)"
  - "Bash(ln -sf *)"
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
/worktree fix-submodules <path>  # Fix submodules in an existing worktree
/worktree verify         # Check if .worktrees/ paths match branch names
```

## Smart Mode (No Subcommand)

When no subcommand is provided, automatically detect the current situation and recommend or resolve as appropriate.

### Detection Logic

1. **Detect if we're in a worktree or main repo:**
   - Check if `git rev-parse --git-common-dir` differs from the current `.git` location
   - If in a worktree, get the worktree path and branch name

2. **If in main repo:**
   - Run `verify` to check all worktrees for issues
   - Suggest creating a new worktree if none exist
   - List any existing worktrees and offer to create another

3. **If in a worktree:**
   - Check if submodules are broken:
     - Look for broken symlinks in `lib/`
     - Try to resolve a submodule path (e.g., `lib/some-sub/Cargo.toml`)
     - If broken or unreachable, suggest `fix-submodules`
   - Check if `.worktrees/path/to/name` matches current branch name:
     - Extract expected path from branch (e.g., `feat/auth` → `.worktrees/feat/auth`)
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
   - If all healthy, report success and offer to open the worktree or run a build check

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

6. **Symlink submodules in `lib/`** from the main repo into the worktree (only
   if `lib/` exists in the main repo). Git rejects symlinks in intermediate path
   components (CVE-2024-32002), so you must create a **real directory** with
   **individual symlinks** inside — never symlink the entire `lib/` dir.
   - Remove any existing `lib/` in the worktree: `rm -rf <worktree-path>/lib`
   - Create a real directory: `mkdir <worktree-path>/lib`
   - For each submodule in `<main-repo-root>/lib/`, create an individual symlink
     using a **relative path**. **Count the directory depth** from the symlink
     location back to the main repo root — the number of `../` segments must
     match. For example:
     - `.worktrees/<name>/lib/<sub>` -> `../../../lib/<sub>` (3 levels up)
     - `.worktrees/<cat>/<name>/lib/<sub>` -> `../../../../lib/<sub>` (4 levels
       up)

     **CRITICAL: Always compute the depth dynamically** by counting path
     components between `<worktree-path>/lib/` and `<main-repo-root>`. Do NOT
     hardcode `../../../` — worktree names with slashes (e.g., `feat/foo`)
     create extra nesting levels. A wrong depth silently breaks nested submodule
     resolution (e.g., `rain-math-float` inside `rain.orderbook/lib/.../lib/`),
     causing `cargo check` to fail with "No such file or directory" on deeply
     nested `Cargo.toml` paths.
     ```bash
     # Compute relative prefix dynamically:
     # From <worktree-path>/lib/, count dirs back to <main-repo-root>
     ln -sf <computed-relative-prefix>/lib/<submodule> <worktree-path>/lib/<submodule>
     ```
   - Mark all `lib/` submodule entries as assume-unchanged so `gt modify -a` and
     `git add -A` won't stage submodule pointer changes:
     ```bash
     cd <worktree-path> && git ls-tree --name-only HEAD lib/ | xargs git update-index --assume-unchanged
     ```

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

### fix-submodules

Fix broken submodules in an already-created worktree. Run this if submodule symlinks are missing or broken, or if `cargo check` fails with "No such file or directory" on Cargo.toml paths.

**Arguments:** `<worktree-path>` — the path to the worktree (e.g., `.worktrees/feat/auth`)

#### Steps

1. **Resolve paths:**
   - Main repo root: run `git rev-parse --git-common-dir` from the worktree and strip the `/.git` suffix.
   - Worktree path: validate it exists and is a git worktree.

2. **Check if `lib/` exists** in the main repo. If it doesn't, report and exit.

3. **Recreate the `lib/` symlink structure:**
   - Remove the existing `lib/` directory: `rm -rf <worktree-path>/lib`
   - Create a real directory: `mkdir <worktree-path>/lib`
   - For each submodule in `<main-repo-root>/lib/`, create an individual symlink using a relative path.
   - **Compute the relative path dynamically** by counting directory depth from `<worktree-path>/lib/` back to `<main-repo-root>`. For example:
     - `.worktrees/<name>/lib/<sub>` -> `../../../lib/<sub>` (3 levels)
     - `.worktrees/<cat>/<name>/lib/<sub>` -> `../../../../lib/<sub>` (4 levels)
   - Create each symlink:
     ```bash
     ln -sf <computed-relative-prefix>/lib/<submodule> <worktree-path>/lib/<submodule>
     ```

4. **Mark all submodule entries as assume-unchanged:**
   ```bash
   cd <worktree-path> && git ls-tree --name-only HEAD lib/ | xargs git update-index --assume-unchanged
   ```

5. **Report** what was fixed.

### verify

Check if the `.worktrees/` directory structure matches actual branch names. This helps identify when worktree paths and branch names have diverged.

**Arguments:** none — scans all worktrees in the current repo

#### Steps

1. **Resolve the main repo root** using `git rev-parse --git-common-dir`.

2. **Check if `.worktrees/` exists.** If it doesn't, report that no worktrees exist.

3. **Find all worktrees** in `.worktrees/` (recursively, since nesting is allowed).

4. **For each worktree path:**
   - Extract the branch name: `git -C <worktree-path> rev-parse --abbrev-ref HEAD`
   - Compare it to the path structure (e.g., `.worktrees/feat/auth` → `feat/auth`)
   - If they match, mark as ✓
   - If they don't match, report the mismatch with the actual branch name

5. **Report a summary:**
   - List all worktrees and their status
   - For mismatches, show the expected path vs. the actual branch
   - Suggest moving the worktree if the user wants the path to match the branch (not automated — requires user decision)
