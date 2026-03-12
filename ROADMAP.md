# Roadmap

## Notes sync

Bidirectional markdown sync between st0x repos and a unified Obsidian vault.

- [x] Extract md-sync into standalone nix package (`nix run .#mdSync`)
- [ ] Sync st0x repos (liquidity, issuance + worktrees) with `.repo.md` qualification
- [ ] fswatch-based continuous sync
- [ ] Redeploy as launchd service
- [ ] dotconfig sync support (~/.config → notes/dotconfig)

## Emacs Graphite Plugin

Build a magit extension for Graphite (`magit-graphite.el`). Transient-based UI
wrapping `gt` commands with magit-style UX.

### Phase 1: Core transient

- Transient menu accessible from magit dispatch (`G` prefix or similar)
- `gt create`, `gt modify`, `gt submit`, `gt co`, `gt sync` wrappers
- Stack visualization (`gt ls` / `gt ll` output in a buffer)

### Phase 2: Magit integration

- Stack status section in magit-status buffer
- Per-branch PR status (draft/open/merged)
- Submit from magit with publish/draft toggle

### Phase 3: Full workflow

- `gt absorb` integration with magit staging
- `gt reorder` / `gt move` via interactive UI
- PR review status from Graphite API

## AI Automation

Once the plugin is stable and the workflow is familiar, switch from "ask user to
run commands" to letting the AI run `gt` commands directly.
