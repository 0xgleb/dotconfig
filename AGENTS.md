# Nix Style Guidelines

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
