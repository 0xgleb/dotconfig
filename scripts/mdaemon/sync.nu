# Entrypoint for md-sync. Library functions are in md-sync-lib.nu
# (concatenated by nix at build time via builtins.readFile)
#
# --notes: override the notes directory (default: ~/code/st0x/notes)
# --watch: after initial sync, watch for filesystem changes via fswatch
# https://www.nushell.sh/book/custom_commands.html#flags
def main [--notes: string, --watch] {
  let org_root = $"($env.HOME)/code/st0x"

  # null check: flags are null when not provided
  let notes_root = if $notes != null { $notes } else { $"($org_root)/notes" }
  let repos = [liquidity issuance rest.api]

  let sync_targets = build-targets $org_root $repos

  sync-all $sync_targets $notes_root

  if $watch {
    print "watching for changes..."

    # Build list of directories to watch: notes dir + all repo roots
    # https://www.nushell.sh/commands/docs/prepend.html
    let watch_paths = ($repos
      | each {|repo| $"($org_root)/st0x.($repo)" }
      | prepend $notes_root)

    # fswatch streams changed file paths to stdout.
    # ...$watch_paths spreads the list as positional args
    # https://www.nushell.sh/book/operators.html#spread-operator
    # `| lines` splits the stream into individual lines as they arrive
    # https://www.nushell.sh/commands/docs/lines.html
    (fswatch -l 3 -x
      --exclude '\.git' --exclude '\.obsidian' --include '\.md$' --exclude '.*'
      ...$watch_paths
      | lines
      | each {|changed_line|
        let timestamp = (date now | format date '%H:%M:%S')
        print $"[($timestamp)] fswatch: ($changed_line)"

        # fswatch -x appends flags after a space; grab just the path
        let changed_path = ($changed_line | split row ' ' | first)
        let repo = (repo-for-path $changed_path $sync_targets $notes_root)

        if $repo != null {
          print $"[($timestamp)] syncing ($repo)..."
          # where returns a table; first gets the single matching row
          # .path accesses the "path" column of that row (cell path)
          # https://www.nushell.sh/book/types_of_data.html#cell-paths
          let target = ($sync_targets | where name == $repo | first)
          sync-repo $target.path $target.name $notes_root
        }
      })

    null
  }
}
