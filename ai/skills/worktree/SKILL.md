---
name: worktree
description: Manage worktrees only for concurrent work by the owner or agents launched by the owner on the same repository, or for explicitly requested inventory and cleanup; never create one for isolation alone.
user-invocable: true
allowed-tools:
  - "Bash(git *)"
  - "Bash(mkdir *)"
  - "Bash(fix-worktree-submodules *)"
  - "Bash(ls *)"
  - "Bash(cd *)"
---

# Worktrees

## When to Use

Worktrees are permitted ONLY when the owner or another agent launched by the
owner is concurrently working on the same repository as an agent. Isolation
alone, dirty local state, ordinary setup, review, builds, and agent-initiated
fan-out never justify a worktree. Explicit owner requests to inventory or remove
existing worktrees authorize that cleanup, not new worktrees.

The assigned checkout remains the default workspace. Without owner-authorized
concurrent work or an explicit inventory/cleanup request, inspect only that
checkout and do not enter other worktrees.

## Procedure

1. Verify Git topology with `git rev-parse --show-toplevel`,
   `git rev-parse --git-common-dir`, and, when inventory is authorized,
   `git worktree list --porcelain`. GitButler is valid only in an existing
   managed main worktree; use plain Git in every linked worktree.
2. Before creation, identify the owner or owner-launched agent working on the
   same repository concurrently. If none exists, do not create a worktree.
3. Use a stable repository-local role slot: `.worktrees/secondary`,
   `.worktrees/tertiary`, or an explicitly disposable `.tmp/worktrees/secondary`
   or `.tmp/worktrees/tertiary`. Never use PR-, ticket-, branch-, timestamp-,
   experiment-, or task-named directories. Verify existing ownership before
   reusing a slot.
4. Create only the selected slot from the task's verified base. Do not change
   VCS backends, fetch unrelated branches, or initialize environments as routine
   setup. Record artifact provenance for a newly created disposable slot when
   the harness exposes that tool.
5. Repair submodules only if concurrent work actually requires them. Use
   `fix-worktree-submodules` only when that command exists; otherwise inspect
   the repository's documented equivalent before acting.
6. The creating agent owns removal of its worktree registration, directory, and
   generated outputs immediately after concurrent work succeeds, fails, or is
   cancelled. A pre-existing owner-managed slot may remain; an agent-created
   slot may remain only with explicit owner direction.

## Cleanup

Use `git worktree remove` with each exact verified linked-worktree path.
Preserve uncommitted work unless the owner explicitly authorizes discarding it.
When the owner orders removal regardless of contents, honor that exact
authorization; Git's documented `--force` option may be needed for dirty
worktrees. Never remove the main checkout or unrelated files. Remove stale
registrations only within the requested repository scope.

If safe cleanup is blocked, record the exact path and reason, keep completion
blocked, and make cleanup the first resumed action. Do not leave disk debt for
the owner or another agent.

## Verification

- `git worktree list --porcelain` shows only the intended registrations.
- Every removed exact path is absent, including its generated outputs.
- No worktree was created without verified owner-authorized concurrency.
- Explicit requests for zero linked worktrees leave only the main checkout.
