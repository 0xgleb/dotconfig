---
name: worktree
description: Create a new git worktree from the main branch of the current repository with full project setup (graphite, direnv, database).
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
  - AskUserQuestion
---

# Worktree Skill

Create a new git worktree from the main branch of the current repository.

## Steps

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
   if `lib/` exists in the main repo). Git rejects symlinks in intermediate
   path components (CVE-2024-32002), so you must create a **real directory**
   with **individual symlinks** inside — never symlink the entire `lib/` dir.
   - Remove any existing `lib/` in the worktree: `rm -rf <worktree-path>/lib`
   - Create a real directory: `mkdir <worktree-path>/lib`
   - For each submodule in `<main-repo-root>/lib/`, create an individual
     symlink using a **relative path**. **Count the directory depth** from the
     symlink location back to the main repo root — the number of `../` segments
     must match. For example:
     - `.worktrees/<name>/lib/<sub>` -> `../../../lib/<sub>` (3 levels up)
     - `.worktrees/<cat>/<name>/lib/<sub>` -> `../../../../lib/<sub>` (4 levels up)

     **CRITICAL: Always compute the depth dynamically** by counting path
     components between `<worktree-path>/lib/` and `<main-repo-root>`. Do NOT
     hardcode `../../../` — worktree names with slashes (e.g., `feat/foo`)
     create extra nesting levels. A wrong depth silently breaks nested
     submodule resolution (e.g., `rain-math-float` inside
     `rain.orderbook/lib/.../lib/`), causing `cargo check` to fail with
     "No such file or directory" on deeply nested `Cargo.toml` paths.
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

7. **Allow direnv** and wait for the nix shell to initialize (only if a
   `.envrc` file exists in the worktree):
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
