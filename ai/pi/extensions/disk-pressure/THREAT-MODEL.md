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
- **Deleting user-owned results:** a result link is removable only when it was absent in the pre-build snapshot and created by that tool call.
- **Destroying useful global caches:** the extension never invokes Nix garbage collection, package-manager cache cleaning, or recursive deletion. It asks for explicit authorization instead.
- **Fresh diagnostic loss:** Pi temp logs must exceed the retention age before cleanup.
- **Command-parser confusion:** expensive-command detection can only add a conservative block; it never authorizes or executes a command.
- **Statistics failure:** missing disk statistics fail closed for automatic cleanup and leave the command to existing policy rather than inventing capacity.

## Verification

- Tests reject nested, fresh, and lookalike temp paths.
- Tests preserve pre-existing result links, unrelated links, regular files, and symlink targets.
- Tests block representative expensive builds below the configured reserve.
