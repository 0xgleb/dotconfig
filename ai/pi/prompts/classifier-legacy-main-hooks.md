Require the repository-approved VCS backend and inspect all active hook
configuration and sources. An existing formatting-only hook may run normally
when its exact formatter check passes for every staged blob, its runner
preserves unstaged changes, and it cannot add unrelated paths; require post-hook
committed path and blob equality before any push. Unknown hooks,
behavior-changing hooks, unreviewed index entries, changed staged blobs, failed
gates, force, hook bypass, or different branches remain blocked.
