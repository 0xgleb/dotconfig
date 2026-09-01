# Disk-pressure cleanup threat model

## Trust boundaries

- Model-authored shell commands cross into build classification.
- Filesystem statistics cross into the reserve decision.
- Temporary-directory and working-directory entries cross into cleanup logic.

## Assets

- User files, caches, Nix generations, and pre-existing result links.
- Enough free disk capacity for Pi and the operating system to remain stable.
- Build diagnostics that are still recent enough to debug.

## Abuse cases and controls

- **Path traversal or broad deletion:** cleanup accepts only direct children of a trusted root with exact names. It never accepts a model-provided cleanup path.
- **Symlink target deletion:** result cleanup uses `lstat` and `unlink`; it never follows or recursively removes a target.
- **Deleting user-owned results:** a result link is removable only when it was absent in the pre-build snapshot and exactly one tracked build owns that working directory. Concurrent builds disable automatic result-link cleanup rather than guessing attribution.
- **Destroying useful global caches:** the extension never invokes Nix garbage collection, package-manager cache cleaning, or recursive deletion. It asks for explicit authorization instead.
- **Fresh diagnostic loss:** Pi temp logs must exceed the retention age before cleanup.
- **Command-parser confusion:** expensive-command detection can only add a conservative block; it never authorizes or executes a command. Known bounded wrappers such as `direnv exec <path>` and native Nushell line-start `^` commands are recognized for classification, including `cargo check` and `nix run`; quoted prose is not treated as execution. The guard never rewrites the command.
- **Post-build reserve crossing:** expensive work requires 64 GiB of free-disk headroom while 32 GiB remains the critical crash reserve. Every recognized expensive command reconciles disk pressure again after its tool result. Crossing below the critical reserve claims a disk-specific incident and assigns bounded cleanup immediately instead of waiting for another build attempt.
- **Statistics failure:** missing disk statistics fail closed for automatic cleanup and leave the command to existing policy rather than inventing capacity.
- **Fleet trigger storm:** separate owner-only atomic incident leases let only one Pi session trigger remediation for each critical disk or memory window; stale leases expire and healthy capacity clears the corresponding incident. A failed notification or steering delivery releases its lease before reporting the typed failure so remediation cannot remain falsely owned.
- **Process-data disclosure:** the harness snapshots only RSS and executable command names, never process arguments or environment values, and bounds the aggregate before adding it to the remediation turn.
- **Unsafe automatic termination:** the incident turn may cancel or clean only evidenced agent-owned workers/artifacts. User applications and unrelated processes require a focused confirmation naming the observed aggregate.

## Verification

- Tests reject nested, fresh, and lookalike temp paths.
- Tests preserve pre-existing result links, unrelated links, regular files, and symlink targets.
- Tests block representative expensive builds below the configured reserve.
