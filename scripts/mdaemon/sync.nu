# Entrypoint for md-sync. Library functions are in md-sync-lib.nu
# (concatenated by nix at build time via builtins.readFile)
#
# --notes: override the notes directory (default: ~/code/st0x/notes)
# --watch: after initial sync, watch for filesystem changes via fswatch
# https://www.nushell.sh/book/custom_commands.html#flags
const MAX_CONSECUTIVE_FAILURES = 10
const BACKOFF_SECONDS = 30

def main [--notes: string, --watch] {
  let org_root = $"($env.HOME)/code/st0x"

  let notes_root = if $notes != null { $notes } else { $"($org_root)/notes" }

  let sync_targets = (build-targets $org_root $notes_root)
  print $"md-sync starting | notes=($notes_root) targets=($sync_targets | get name | str join ', ')"

  sync-all $sync_targets $notes_root
  print "initial sync complete"

  if $watch {
    print "watching for changes..."

    let watch_paths = ($sync_targets
      | get path
      | prepend $notes_root
      | uniq)

    print $"watching paths: ($watch_paths | str join ', ')"

    mut consecutive_failures = 0

    (fswatch -l 3 -x
      --exclude '\.git' --exclude '\.obsidian' --include '\.md' --exclude '.*'
      ...$watch_paths
      | lines
      | each {|changed_line|
        let timestamp = (date now | format date '%H:%M:%S')
        print -e $"[($timestamp)] fswatch: ($changed_line)"

        let changed_path = ($changed_line | split row ' ' | first)
        let repo = (repo-for-path $changed_path $sync_targets $notes_root)

        if $repo != null {
          let target = ($sync_targets | where name == $repo | first)

          try {
            sync-repo $target.path $target.name $notes_root
            $consecutive_failures = 0
          } catch {|e|
            $consecutive_failures = $consecutive_failures + 1
            print -e $"[($timestamp)] [ERROR] watch sync failed (($consecutive_failures)/($MAX_CONSECUTIVE_FAILURES)): ($e.msg)"

            if $consecutive_failures >= $MAX_CONSECUTIVE_FAILURES {
              print -e $"[($timestamp)] [FATAL] ($MAX_CONSECUTIVE_FAILURES) consecutive failures, backing off ($BACKOFF_SECONDS)s"
              sleep ($"($BACKOFF_SECONDS)sec")
              $consecutive_failures = 0
              print -e $"[(date now | format date '%H:%M:%S')] resuming after backoff"
            }
          }
        } else {
          print -e $"[($timestamp)] no matching target for ($changed_path), skipping"
        }
      })

    null
  }
}
