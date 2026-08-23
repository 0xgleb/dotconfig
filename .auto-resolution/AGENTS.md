# Nix Style Guidelines

- Shared skills may contain tool names for multiple harnesses. Before following a
  named tool procedure in Pi, verify that the tool is actually exposed. If not,
  use an available semantically equivalent tool while preserving exact scope,
  exclusions, and mutation boundaries. Never stop merely because another harness's
  tool name appears in `allowed-tools`, and never treat that substitution as evasion.
- **Flatten small attribute sets**: When an attrset has fewer than 3 items (1 or
  2), use dotted paths instead of nesting:
  ```nix
  # Good
  fzf.enable = true;
  fzf.enableZshIntegration = true;

  # Bad
  fzf = {
    enable = true;
    enableZshIntegration = true;
  };
  ```
- **Group related attrs**: Consolidate repeated top-level keys into a single
  block (e.g. one `programs = { ... };` instead of many `programs.foo = ...;`
  blocks)
- **nixfmt**: The repo uses nixfmt for formatting

# Neovim Config

## Testing requirements

After any change to nvim keybindings, mappings, or the README cheatsheet, run
the mapping tests before committing:

```bash
nvim --headless -c "luafile nvim/test_mappings.lua" -c "qa!"
```

All tests must pass. If you add, remove, or change a binding in
`lua/plugins/astrocore.lua`, update `test_mappings.lua` to match. If you change
the README cheatsheet, update the tests to match. The tests are the source of
truth for what the config should do — never commit mapping changes without
verifying them.

Common mistakes to avoid:

- Using `<Leader>SPC` instead of `<Leader><Space>` (nvim doesn't recognize the
  former)
- Overriding AstroNvim defaults without disabling them first (e.g., `<Leader>c`
  is bound to close buffer by default — must set to `false` before adding
  submappings)
- Adding a binding to the README without adding it to the config (or vice versa)

# fj — unified dev command

`fj` (aliases `f`, `j`) is a nushell module at `nushell/fj/` that is the
user's single entry point for day-to-day version control and dev chores. It
dispatches a subcommand to the right underlying tool: `git`, a stacking backend
(`gt`/`but`), `gh`, or an internal workflow (`do`, `check`, `take`, `md`,
`infra`). Run `fj help` for the full command list.

## VCS backend routing

Only a few orgs use Graphite, so stack-style commands (`ss`, `create`, `sync`,
`co`, `restack`, `mut`, …) are routed per repository:

- `~/code/rainlanguage/*` and `~/code/st0x/*` → **`gt`** (Graphite), in both main and linked worktrees
- another GitButler-managed repo's verified **main worktree** → **`but`**
- every linked/non-main worktree, including those attached to a GitButler-managed repo → plain **`git`**
- otherwise → plain **`git`**

GitButler must never be invoked outside the main worktree; detect topology before routing instead of waiting for `but` to fail. Plain git commands (`add`, `commit`, `push`, `status`, `diff`, `log`, …) always route to `git` regardless of backend. `gh`-backed commands (`issue`, `pr`) and internal workflows are backend-independent.

The stack **verbs are translated**, not passed through — gitbutler has a
different vocabulary and no stack cursor. For example `fj mut` → `gt modify` /
`but amend` / `git commit --amend`; `fj co` → `gt co` / `but apply` / `git
checkout`; `fj create` → `gt create` / `but branch new` / `git checkout -b`.
Graphite-only verbs with no equivalent (the `up`/`down`/`top`/`bottom` cursor
moves, and on git also `squash`/`absorb`/`move`/…) error with a clear message
instead of being guessed at. The translation tables are `but_translations` and
`git_translations` in `routing.nu`.

To change which orgs use Graphite, edit `graphite_orgs` in
`nushell/fj/routing.nu`.

## Routing internals

`nushell/fj/routing.nu` holds the pure, testable routing logic:

- `fj-route ...args` — maps the invocation to `{ tool, args }` (logical routing;
  stack commands carry tool `"gt"`)
- `vcs-backend cwd home gitbutler_available` — resolves `"gt" | "but" | "git"`
  for a working directory
- `resolve-stack route backend` — translates a stack route (tool `"gt"`) to the
  active backend, mapping both the tool and the verb; returns tool
  `"unsupported"` (carrying `[verb, backend]`) when there is no equivalent.
  Non-stack routes pass through unchanged.

`mod.nu` wires them together (`vcs-backend $env.PWD $env.HOME (which but |
is-not-empty)`), then dispatches; an `"unsupported"` route errors with a clear
message. Run the unit tests after any routing change:

```bash
nu nushell/fj/routing.test.nu
```

# Agent Delivery

Validated changes in this repository must be committed and pushed on the active
feature branch unless the user explicitly says not to publish them. Committing
and pushing are routine completion steps here; do not stop to hand them back to
the user or request redundant authorization.

# Work Tracking

This repo does **not** use Linear. Work here is tracked in GitHub issues/PRs (or
nowhere) — never create or defer findings to Linear for dotconfig. Linear is the
tracker only for the `~/code/st0x/*` and `~/code/rainlanguage/*` repos (the same
orgs that route stacks to Graphite). The `linear` skill applies there, not here.

# Agents and Services

## Markdown Sync Service

The `syncNotes` launchd service provides bidirectional synchronization of
markdown files between source repositories and a unified notes vault at
`~/code/st0x/notes/`.

**Service:** `launchd.user.agents.syncNotes` (darwin.nix) **Logs:**
`/tmp/sync-notes.out`, `/tmp/sync-notes.err` **Status:** Runs continuously,
watches for file changes, syncs automatically

### Synced Repositories

- `~/code/st0x/st0x.liquidity` → `notes/liquidity/`
- `~/code/st0x/st0x.issuance` → `notes/issuance/`
- `~/code/st0x/st0x.REPO/.worktrees/*/` → `notes/WTNAME/`
- `~/.config` → `notes/dotconfig/`

### Sync Behavior

**Forward Sync (Repos → Notes)**

- Runs on startup and whenever `.md` files change in source repos
- Preserves directory structure: `docs/file.md` stays as `docs/file.md`
- For worktrees: appends repo name to filename: `docs/file.md` →
  `docs/file.liquidity.md`

**Reverse Sync (Notes → Repos)**

- Only syncs files that have parity in source repositories
- Files in notes without corresponding source files are never modified or
  deleted
- Allows editing in Obsidian and syncing changes back to source repos

**Dot Replacement**

- Paths starting with `.` are renamed: `.config` → `dotconfig`
- Applied at directory level in vault path

### File Organization

```
notes/
  liquidity/              # from st0x.liquidity
    docs/
      file.md
    ROADMAP.md
  issuance/               # from st0x.issuance
    ROADMAP.md
    src/
      architecture.md
  feat-branch/            # from worktree .worktrees/feat/feat-branch/
    docs/
      design.liquidity.md
  dotconfig/              # from ~/.config
    CLAUDE.md
    home.nix.md
```

### Logs

Logs show:

- Sync operations with file counts
- Individual file movements with arrows: `→` (forward), `←` (reverse)
- Change detection and timing
- Color-coded output for easy monitoring

Watch logs:

```bash
tail -f /tmp/sync-notes.out
```
