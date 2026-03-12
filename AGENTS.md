# Agents and Services

## Markdown Sync Service

The `syncNotes` launchd service provides bidirectional synchronization of markdown files between source repositories and a unified notes vault at `~/code/st0x/notes/`.

**Service:** `launchd.user.agents.syncNotes` (darwin.nix)
**Logs:** `/tmp/sync-notes.out`, `/tmp/sync-notes.err`
**Status:** Runs continuously, watches for file changes, syncs automatically

### Synced Repositories

- `~/code/st0x/st0x.liquidity` → `notes/liquidity/`
- `~/code/st0x/st0x.issuance` → `notes/issuance/`
- `~/code/st0x/st0x.REPO/.worktrees/*/` → `notes/WTNAME/`
- `~/.config` → `notes/dotconfig/`

### Sync Behavior

**Forward Sync (Repos → Notes)**
- Runs on startup and whenever `.md` files change in source repos
- Preserves directory structure: `docs/file.md` stays as `docs/file.md`
- For worktrees: appends repo name to filename: `docs/file.md` → `docs/file.liquidity.md`

**Reverse Sync (Notes → Repos)**
- Only syncs files that have parity in source repositories
- Files in notes without corresponding source files are never modified or deleted
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
