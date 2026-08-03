# Background sync daemon for markdown vault.
# Runs as a launchd service, not as part of the fj module.
# Expects md-sync-lib.nu to be in the same directory.

source md-sync-lib.nu

const MAX_FAILURES = 10
const BACKOFF_SECS = 30

def main [--config: string, --watch] {
  let config_path = if $config != null { $config } else { $DEFAULT_CONFIG_PATH }
  let cfg = (load-config $config_path)
  let notes_root = $cfg.vault
  let sync_targets = (build-all-targets $cfg)

  print $"md-sync starting | vault=($notes_root) targets=($sync_targets | get name | str join ', ')"

  sync-all $sync_targets $notes_root
  print "initial sync complete"

  if $watch {
    print "watching for changes..."

    let watch_paths = ($sync_targets
      | get path
      | prepend $notes_root
      | uniq)

    print $"watching paths: ($watch_paths | str join ', ')"

    mut failures = 0

    # `for` (not `each`) so the loop body runs in the current scope and can
    # update `failures`; a closure would fail to capture the `mut`.
    # The fswatch pipeline stays inline so the loop streams events as they
    # arrive instead of waiting for the (never-ending) command to finish.
    for changed_line in (
      fswatch -l 3 -x
        --exclude '\.git' --exclude '\.obsidian' --include '\.md' --exclude '.*'
        ...$watch_paths
      | lines
    ) {
      let timestamp = (date now | format date '%H:%M:%S')
      print -e $"[($timestamp)] fswatch: ($changed_line)"

      let changed_path = ($changed_line | split row ' ' | first)
      let repo = (repo-for-path $changed_path $sync_targets $notes_root)

      if $repo == null {
        print -e $"[($timestamp)] no matching target for ($changed_path), skipping"
        continue
      }

      let target = ($sync_targets | where name == $repo | first)

      # `catch` is a closure, so it returns the outcome instead of mutating
      # the counter directly; the mutation happens back in the loop scope.
      let outcome = try {
        sync-repo $target.path $target.name $notes_root
        { ok: true, msg: "" }
      } catch {|e|
        { ok: false, msg: $e.msg }
      }

      if $outcome.ok {
        $failures = 0
        continue
      }

      $failures = $failures + 1
      let progress = $"($failures)/($MAX_FAILURES)"
      print -e $"[($timestamp)] [ERROR] watch sync failed ($progress): ($outcome.msg)"

      if $failures >= $MAX_FAILURES {
        let msg = $"($MAX_FAILURES) consecutive failures, backing off ($BACKOFF_SECS)s"
        print -e $"[($timestamp)] [FATAL] ($msg)"
        sleep ($BACKOFF_SECS * 1sec)
        $failures = 0
        print -e $"[(date now | format date '%H:%M:%S')] resuming after backoff"
      }
    }

    null
  }
}
