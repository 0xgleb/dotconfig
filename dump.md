# md-sync

Bidirectional markdown sync: st0x repos → unified Obsidian vault.

## Plan

**Structure**: `notes/{repo}/` mirrors exact repo paths, only `.md` files. No
suffix qualification.

```
notes/
  liquidity/   — mirrors st0x.liquidity
  issuance/    — mirrors st0x.issuance
  rest.api/    — mirrors st0x.rest.api
```

**Bidirectional**: forward (repo → notes) always runs. Reverse (notes → repo)
uses `rsync -u` so newer file wins, scoped to files that exist in repo's git
tree.

**Package**: `flake.nix` → `packages.aarch64-darwin.mdSync` → `md-sync` **CLI**:
`md-sync [--notes DIR]` — defaults to `~/code/st0x/notes` **Service**: disabled
in darwin.nix, will re-enable after testing

## What's done

- [x] Per-repo subdirs with exact paths (no suffix)
- [x] Bidirectional sync (forward + reverse with `rsync -u`)
- [x] All 3 repos: liquidity (17), issuance (12), rest.api (3)
- [x] Top-level file mkdir bug fixed
- [x] `--notes` CLI arg for test output dir
- [x] Branch: `md-sync/simple` stacked on `md-sync/test` on `md-sync/rewrite`

## What's next

- [ ] Test idempotency (run twice, no changes)
- [ ] Test reverse sync (edit a file in notes, re-run, verify repo gets update)
- [ ] Re-enable launchd service with fswatch
- [ ] `gt ss` to push stack
