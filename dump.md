# Sync Notes Service Implementation

## Current Plan (2026-03-12 10:00)

**Core rule**: Replicate exact folder structure from source repos into notes dir. Qualify every markdown file with repo suffix (`.liquidity.md`, `.issuance.md`) to avoid conflicts between repos/worktrees sharing the same file paths.

**What changed**: No more separate destination structure per worktree. All files from all worktrees and main repos land in the SAME structure, differentiated only by the `.repo.md` suffix.

**Dropped**: dotconfig sync (future ROADMAP item). Fancy visualization (just make it testable).

**Configurable roots** (for testing):
- Org root: `~/code/st0x` (test: `.tmp/org`)
- Notes root: `~/code/st0x/notes` (test: `.tmp/notes`)

**Stack plan**:
1. Current branch: rewrite md-sync with configurable roots, no visualization
2. Stack: test with .tmp/ dirs until consistent
3. Stack: redeploy service with real paths

## Immediate Next Steps (context handoff)

State: on branch `feat/sync`. All files are modified but NOT committed — git objects had a root ownership issue. User ran `sudo chown -R 0xgleb:staff ~/.config/.git/objects/` to fix.

**What to do next:**
1. `git add flake.nix darwin.nix dump.md ROADMAP.md .gitignore` then `gt modify`
2. `nix run .#mdSync` to verify the rewritten package works (env vars: `MD_SYNC_ORG`, `MD_SYNC_NOTES`)
3. The package is in `flake.nix` under `packages.aarch64-darwin.mdSync` — simple `sync_repo` function that uses `git ls-tree | grep .md` then rsyncs with `.repoName.md` suffix
4. Service is DISABLED (commented out in darwin.nix). User needs to `darwin-rebuild switch` to remove it from launchd
5. `.tmp/` and `/result` are gitignored
6. `nix run .#mdSync` is allow-listed in `.claude/settings.local.json` (but the `permissions.allow` block was removed by user edit — check if it needs re-adding)
7. After testing with `MD_SYNC_ORG=.tmp/org MD_SYNC_NOTES=.tmp/notes nix run .#mdSync`, stack a branch for the service redeploy

## Overview
Bidirectional markdown sync service that automatically mirrors markdown files from source repos to a unified notes vault at `~/code/st0x/notes/` for Obsidian indexing.

## What We Built

### Launchd Service: `org.nixos.syncNotes`
- **Location**: darwin.nix (lines ~47-166)
- **Runtime**: Continuous `KeepAlive = true`, starts on boot `RunAtLoad = true`
- **Logs**: `~/Library/Logs/syncNotes.{out,err}`
- **Control**:
  - Stop: `launchctl stop org.nixos.syncNotes`
  - Start: `launchctl start org.nixos.syncNotes`

### Source Repos Synced
1. `~/code/st0x/st0x.liquidity/` → `notes/liquidity/`
2. `~/code/st0x/st0x.issuance/` → `notes/issuance/`
3. `~/code/st0x/st0x.liquidity/.worktrees/*/` → `notes/WTNAME/` (files appended with `.liquidity`)
4. `~/code/st0x/st0x.issuance/.worktrees/*/` → `notes/WTNAME/` (files appended with `.issuance`)
5. `~/.config/` → `notes/dotconfig/`

### Sync Behavior

**Step 1: Build markdown list (upfront)**
- `build_md_list()` function queries all source repos with `git ls-tree -r --name-only HEAD | grep '\.md$'`
- Builds complete list of markdown files from:
  - Main repos (liquidity, issuance, .config)
  - All worktrees
- Returns absolute paths to all markdown files only
- Prevents fswatch from being triggered by non-markdown file changes

**Step 2: fswatch (monitor for changes)**
- Watches source directories for file changes
- Only triggers on actual `.md` file modifications
- Excludes notes directory to prevent infinite loops

**Step 3: rsync (sync changes)**
- Syncs detected changes to notes vault
- Reverse syncs to bring Obsidian edits back to repos

**Debounce**: 2-second cooldown between syncs to prevent rapid re-triggering

### File Organization Rules

| Source | Output |
|--------|--------|
| `st0x.liquidity/docs/file.md` | `liquidity/docs/file.md` |
| `st0x.liquidity/.worktrees/feat/name/docs/file.md` | `name/docs/file.liquidity.md` |
| `~/.config/AGENTS.md` | `dotconfig/AGENTS.md` |

**Key**:
- Main repos preserve full structure
- Worktree files append repo name before `.md`
- Top-level files stay at top level
- Nested files preserve nesting

### Critical Implementation Details

1. **User config source of truth**:
   - Defined in `common.nix` (lines 8-11)
   - Exported via `_module.args.userConfig`
   - Used in darwin.nix for paths and user creation
   - Prevents hardcoding `/Users/0xgleb` everywhere

2. **Path transformation for .config**:
   - `sed 's|.*/\.|.|'` extracts just `.config`
   - Prepended with `dot` → `dotconfig`
   - Handles the leading dot replacement

3. **Array length fix**:
   - Old code used bash arrays `${#synced[@]}` which failed to expand in Nix strings
   - **SOLUTION**: Use simple counter `count=0` and `((count++))`
   - Print count in summary: `echo ... ($count files)`

4. **Path shortening in logs**:
   - Uses bash parameter expansion: `${path/$HOME/\~}`
   - Replaces home directory with `~` for readability
   - Applied to both source and destination paths

5. **fswatch exclude pattern**:
   - **CRITICAL**: `--exclude="$notesDir"` prevents synced files from triggering new syncs
   - Without this: sync writes → fswatch detects → sync again → infinite loop

## Known Issues & Fixes Applied

### Infinite Loop (FIXED)
- **Problem**: fswatch detected synced files themselves, triggering recursive syncs
- **Cause**: Notes folder was in fswatch watch paths
- **Fix**: Added `--exclude="$notesDir"` to fswatch command

### Array Length Not Expanding (FIXED)
- **Problem**: Logs showed `{#synced[@]}` literally instead of file count
- **Cause**: Bash array syntax doesn't expand in Nix multi-line strings
- **Fix**: Replaced array approach with simple counter variable

### Path Transformation Mangling (FIXED)
- **Problem**: `dotUsers0xglebconfig` instead of `dotconfig`
- **Cause**: Two different sed expressions for forward vs reverse sync — reverse used `sed 's|/||g; s|\.||g; s|^|dot|'` which mangled the entire path
- **Fix**: Use same sed for both: `sed 's|.*/\.|.|'` → extracts `.config` → prepend `dot`

### KeepAlive Respawn Loop (FIXED)
- **Problem**: Service ran in infinite loop, filling logs instantly
- **Cause**: `KeepAlive = true` restarts the process when it exits. When service was changed to just print the file list and exit, launchd kept restarting it
- **Fix**: Set `KeepAlive = false` while testing. Must be `true` for the final fswatch-based service

### fswatch Firing on Everything (FIXED)
- **Problem**: fswatch triggered on every directory in worktrees (node_modules, dist, etc.), not just markdown changes
- **Cause**: `fswatch -r` watches all filesystem events recursively. The old `do_sync` ran on every trigger, calling `git ls-tree` for every repo on every event
- **Fix**: Restructured to build markdown file list upfront (step 1), will use it to scope fswatch (step 2)

### Log Readability Issues (FIXED)
- **Problem**: Full absolute paths (`/Users/0xgleb/code/st0x/...`) made logs unreadable — couldn't see the actual file names
- **Cause**: Using `$HOME`-prefixed paths everywhere
- **Fix**: Use `~` shorthand in section headers for context, relative paths for file listings, and `column -t` (util-linux) for aligned worktree mappings

## Files Modified

- **common.nix**: User config def (lines 8-11), unstable import (line 4)
- **darwin.nix**: launchd service (lines ~47-166), user config usage (lines 1, 7-9)
- **home.nix**: Graphite completion (lines 12-28), zsh config with completion (lines ~48-69)
- **flake.nix**: No launchd service here (moved to darwin.nix)

## Testing & Monitoring

```bash
# Watch logs in real-time
tail -f ~/Library/Logs/syncNotes.out

# Check error logs
tail -f ~/Library/Logs/syncNotes.err

# Manual sync (if needed)
launchctl stop org.nixos.syncNotes
# ... make changes ...
launchctl start org.nixos.syncNotes
```

## Log Output Format

```
[HH:MM:SS] Starting bidirectional sync service...
[HH:MM:SS] Forward sync: liquidity (42 files)
  → ~/code/st0x/st0x.liquidity/docs/file.md → ~/code/st0x/notes/liquidity/docs/file.md
  → ~/code/st0x/st0x.liquidity/ROADMAP.md → ~/code/st0x/notes/liquidity/ROADMAP.md
[HH:MM:SS] Reverse sync: liquidity (3 files)
  ← ~/code/st0x/notes/liquidity/docs/edited.md → ~/code/st0x/st0x.liquidity/docs/edited.md
[HH:MM:SS] Watching for changes in repos...
[HH:MM:SS] Change detected: ~/code/st0x/st0x.liquidity/docs/another.md
```

## Rebuild & Deploy

```bash
darwin-rebuild switch --flake ~/.config
```

This rebuilds the entire system config, applies the launchd service, and starts the sync.

## Git Integration

The service state is managed in two git branches on this repo:
- `ci` - deprecation warning fixes (system→hostPlatform, nixfmt-classic→nixfmt)
- `feat/note-sync` - all sync service changes (current working branch)

Status: Ready to merge/push pending final testing.
