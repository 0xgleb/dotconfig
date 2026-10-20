For that linked-worktree path only, require current exact hook configuration and
source evidence, obtained after the reviewed status snapshot and bound to the
source-fixed gitCommitHooksSnapshotSha256, proving either that no active
pre-commit, prepare-commit-msg, commit-msg, or post-commit hook can add paths or
mutate the index or worktree, or that every mutating hook meets the following
bounded formatting-only contract. An existing formatting-only hook may run
normally only when its exact formatter check passes for every staged blob, its
runner preserves unstaged changes, and it cannot add paths or stage unreviewed
content. Current evidence must pin the relevant hook runner, formatter
executable, arguments, and configuration; the hook-entrypoint fingerprint alone
is insufficient. Unknown runner, configuration, or tool identity,
behavior-changing hooks, and unreviewed staged content remain blocked. For this
formatting-only path, post-commit path, mode, and blob identities must equal the
reviewed index; any mismatch must stop delivery and preserve the evidence, not
be accepted as an implicitly reviewed formatting transform.

If that proof is absent, stale, incomplete, mismatched, or shows an unapproved
mutation, block commit.

This allowance does not require untracked paths to be absent, but it must block
any command or hook that could add or commit them.
