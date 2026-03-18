# mdup Roadmap

## Rich diff output

Show actual file diffs when reviewing a plan, not just action summaries. Users
need to see what changed before applying.

- [x] `mdup diff` subcommand — show unified diffs for all actions in a plan
- [x] `mdup diff --plan <file>` — diff from a specific plan file
- [x] Colorized output with `+`/`-` line prefixes

## Worktree-aware sync

Worktree files should include the repo name in the destination filename to avoid
collisions when multiple repos have the same relative path.

- [ ] Append repo name to worktree file destinations (e.g. `design.liquidity.md`)
- [ ] Handle renames when switching between worktree and main repo sync

## Conflict detection

When both source and destination changed since the last sync, mdup should detect
the conflict instead of silently picking the newer file.

- [ ] Track last-sync hashes in a state file
- [ ] Detect true conflicts (both sides changed since last sync)
- [ ] `mdup plan` reports conflicts as a distinct action type

## Daemon mode

Replace the fswatch-based md-sync daemon with mdup running on a timer.

- [ ] `mdup watch` subcommand — run plan/apply in a loop
- [ ] Configurable interval
- [ ] Replace `mdaemon` launchd service with mdup-based one
