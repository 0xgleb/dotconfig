use std/log

const DEFAULT_CONFIG_PATH = "~/.config/mdaemon.nuon"

export def load-config [path: string] {
  let config_path = ($path | path expand)
  if not ($config_path | path exists) {
    error make { msg: $"config file not found: ($config_path)" }
  }
  let config = (open $config_path)
  {
    vault: ($config.vault | path expand)
    orgs: ($config.orgs | each {|o| $o | path expand })
  }
}

# Discover all sync targets: main repos + their git worktrees.
# Returns a table with {name, path} rows.
# "name" is the notes subdirectory (e.g. "liquidity/worktrees/untouchable")
# "path" is the absolute filesystem path to the repo/worktree
export def build-targets [org_root: string, exclude: string = ""] {
  let repos = (glob $"($org_root)/*" --no-file --no-symlink
    | where {|dir|
      let name = ($dir | path basename)
      # Path-aware: exclude only when dir IS the vault, sits under it, or is an
      # ancestor of it. A bare string-prefix test would wrongly exclude a sibling
      # like `/code/notes-archive` when the vault is `/code/notes`.
      let is_excluded = if $exclude != "" {
        ($dir == $exclude) or ($dir | str starts-with $"($exclude)/") or ($exclude | str starts-with $"($dir)/")
      } else {
        false
      }
      ($"($dir)/.git" | path exists) and (not $is_excluded) and (not ($name | str starts-with "."))
    })

  let main_targets = ($repos | each {|dir|
    { name: ($dir | path basename), path: $dir }
  })

  let worktree_targets = ($repos | each {|dir|
    let repo_name = ($dir | path basename)
    let worktree_dir = $"($dir)/.worktrees"

    if ($worktree_dir | path exists) {
      let one_deep = (glob $"($worktree_dir)/*" --no-file --no-symlink)
      let two_deep = (glob $"($worktree_dir)/*/*" --no-file --no-symlink)
      let candidates = ($one_deep | append $two_deep)
      log debug $"($repo_name): .worktrees/ has ($candidates | length) candidate dirs"

      $candidates
        | each {|worktree_path|
          let worktree_path = ($worktree_path | str trim --right --char '/')
          let has_git = ($"($worktree_path)/.git" | path exists)
          log debug $"  ($worktree_path): .git exists = ($has_git)"

          if $has_git {
            let leaf_name = ($worktree_path | path basename)
            { name: $"($repo_name)/worktrees/($leaf_name)", path: $worktree_path }
          }
        }
        | compact
    }
  } | flatten | compact)

  $main_targets | append $worktree_targets
}

export def build-all-targets [config: record] {
  $config.orgs | each {|org|
    let org_name = ($org | path basename)
    let targets = (build-targets $org $config.vault)
    $targets | each {|t|
      { name: $"($org_name)/($t.name)", path: $t.path }
    }
  } | flatten
}

# Find all markdown files in a repo: committed files + gitignored .local/ files.
# Returns relative paths like "docs/arch.md" or ".local/prompts/01.md"
export def md-files [repo_path: string] {
  let git_files = (do { ^git -C $repo_path ls-tree -r --name-only HEAD }
    | complete
    | get stdout
    | lines
    | where ($it | str ends-with '.md'))

  let local_dir = $"($repo_path)/.local"

  let local_files = if ($local_dir | path exists) {
    glob $"($local_dir)/**/*.md"
      | each {|file_path| $file_path | str replace $"($repo_path)/" '' }
  } else {
    []
  }

  $git_files
    | append $local_files
    | where {|file| ($"($repo_path)/($file)" | path type) != "symlink" }
}

# Strip leading dots from each path segment: ".local/prompts/x.md" -> "local/prompts/x.md"
export def undot [path: string] {
  $path
    | split row '/'
    | each {|segment| $segment | str trim --left --char '.' }
    | str join '/'
}

# Map a repo-relative md path to its notes filename: drop a LEADING `.local/`,
# then undot each segment. ".local/prompts/01.md" -> "prompts/01.md". The strip
# is anchored to the start so a committed path that merely contains `.local/`
# mid-path is left alone.
export def note-file [file: string] {
  $file | str replace --regex '^\.local/' '' | undot $in
}

# note-file is not injective: distinct sources can collapse to one note path
# (`.github/x.md` and `github/x.md` both undot to `github/x.md`; `.local/p/x.md`
# and a committed `p/x.md` both map to `p/x.md`). Group the files by note path and
# return only the colliding groups, so callers can skip them with a warning
# instead of silently overwriting one source with the other.
export def note-collisions [files: list<string>] {
  $files
    | each {|f| { file: $f, note: (note-file $f) } }
    | group-by note
    | items {|note, rows| { note: $note, files: ($rows | get file) } }
    | where {|g| ($g.files | length) > 1 }
}

# Count additions/deletions between two files using unix diff.
export def diff-stats [source: string, destination: string] {
  let diff_output = (do { ^diff $source $destination } | complete | get stdout | lines)

  let additions = ($diff_output | where ($it | str starts-with '>') | length)
  let deletions = ($diff_output | where ($it | str starts-with '<') | length)

  { adds: $additions, dels: $deletions }
}

# Atomically copy a file: stage to a unique temp in the destination's own
# directory, verify, then rename into place. The temp is per-call unique (so the
# continuous daemon and a manual `fj md sync` can't race on a shared temp and
# publish each other's bytes), lives on the destination's filesystem (so the mv
# is a real atomic rename), and is named with a leading dot and no `.md`
# substring so the daemon's fswatch `\.md` include / `.*` exclude never fires on
# it.
export def atomic-cp [source: string, destination: string] {
  let dir = ($destination | path dirname)
  let tmp = (mktemp --tmpdir-path $dir --suffix .tmp ".sync-XXXXXX")
  cp $source $tmp
  let src_hash = (open --raw $source | hash md5)
  let tmp_hash = (open --raw $tmp | hash md5)
  if $src_hash != $tmp_hash {
    rm -f $tmp
    error make { msg: $"copy verification failed: ($source) -> ($destination)" }
  }
  mv --force $tmp $destination
}

# Snapshot the file about to be overwritten so a bidirectional clobber is always
# recoverable. mtime-wins resolution can't tell a one-sided edit from a true
# concurrent edit (no last-synced baseline is kept), so before the losing side is
# overwritten its current bytes are copied, timestamped, into a hidden
# `<notes_root>/.md-sync-conflicts/` tree that sits outside both the git repo and
# the normal vault listing. No-op when notes_root is unset.
def backup-overwritten [victim: string, repo_name: string, note_file: string, notes_root: string] {
  if ($notes_root | is-empty) { return }

  let backup_dir = ([$notes_root ".md-sync-conflicts" $repo_name] | path join)
  mkdir $backup_dir
  let stamp = (date now | format date '%Y%m%dT%H%M%S')
  let flat = ($note_file | str replace --all '/' '_')
  let backup = ([$backup_dir $"($flat).($stamp).bak"] | path join)
  cp $victim $backup
  log warning $"backed up the overwritten ($repo_name)/($note_file) to ($backup)"
}

# Refuse to sync when the "newer" file is empty but the older has real content.
export def guard-empty-overwrite [newer: string, older: string] {
  let newer_size = (ls -l $newer | first | get size | into int)
  let older_size = (ls -l $older | first | get size | into int)
  if $newer_size == 0 and $older_size > 0 {
    error make {
      msg: $"refusing to overwrite non-empty file with empty file: ($newer) -> ($older)"
    }
  }
}

# Bidirectional sync of a single file. Newer file wins. When notes_root is given,
# the losing side is backed up before being overwritten (see backup-overwritten)
# so a clobber is recoverable.
export def sync-file [
  source: string,
  destination: string,
  repo_name: string,
  note_file: string,
  notes_root: string = ""
] {
  let timestamp = (date now | format date '%H:%M:%S')
  let label = $"($repo_name)/($note_file)"

  if not ($destination | path exists) {
    mkdir ($destination | path dirname)

    print $"[($timestamp)] [($repo_name) --new--> notes] ($label)"
    atomic-cp $source $destination

  } else if (open --raw $source) != (open --raw $destination) {
    let source_modified = (ls -l $source | first | get modified)
    let destination_modified = (ls -l $destination | first | get modified)

    if $source_modified > $destination_modified {
      guard-empty-overwrite $source $destination
      backup-overwritten $destination $repo_name $note_file $notes_root
      let stats = (diff-stats $destination $source)
      let arrow = $"($repo_name) --+($stats.adds),-($stats.dels)--> notes"
      print $"[($timestamp)] [($arrow)] ($label)"
      atomic-cp $source $destination
    } else {
      guard-empty-overwrite $destination $source
      backup-overwritten $source $repo_name $note_file $notes_root
      let stats = (diff-stats $source $destination)
      let arrow = $"notes --+($stats.adds),-($stats.dels)--> ($repo_name)"
      print $"[($timestamp)] [($arrow)] ($label)"
      atomic-cp $destination $source
    }
  }
}

# Sync all markdown files from a repo into its notes subdirectory.
export def sync-repo [repo_path: string, repo_name: string, notes_root: string] {
  if not ($repo_path | path exists) {
    log warning $"($repo_name): path ($repo_path) does not exist, skipping"
    return
  }

  let repo_notes = $"($notes_root)/($repo_name)"
  mkdir $repo_notes

  let files = (md-files $repo_path)
  log info $"($repo_name): ($files | length) md files"

  # Skip files whose note paths collide: syncing them would let the second
  # overwrite the first. Surface the collision instead of losing data silently.
  let collisions = (note-collisions $files)
  let colliding_notes = ($collisions | get note)
  for c in $collisions {
    log warning ($"($repo_name): note-path collision -- "
      + $"(($c.files) | str join ', ') all map to '($c.note)'; "
      + "skipping all of them. Rename or relocate one to resolve.")
  }
  let safe_files = ($files | where {|file| (note-file $file) not-in $colliding_notes })

  let errors = ($safe_files | each {|file|
    let note_file = (note-file $file)
    let source = $"($repo_path)/($file)"
    let destination = $"($repo_notes)/($note_file)"

    try {
      sync-file $source $destination $repo_name $note_file $notes_root
      null
    } catch {|e|
      log error $"($repo_name)/($note_file): ($e.msg)"
      $e.msg
    }
  } | compact)

  if ($errors | length) > 0 {
    log warning $"($repo_name): ($errors | length) files failed to sync"
  }

  null
}

# Iterate over all targets and sync each one.
export def sync-all [targets: table<name: string, path: string>, notes_root: string] {
  let errors = ($targets | each {|target|
    try {
      sync-repo $target.path $target.name $notes_root
      null
    } catch {|e|
      log error $"repo ($target.name) failed: ($e.msg)"
      $target.name
    }
  } | compact)

  if ($errors | length) > 0 {
    log warning $"($errors | length) repos failed to sync: ($errors | str join ', ')"
  }

  null
}

# Given an absolute path, find which sync target it belongs to.
export def repo-for-path [
  path: string,
  targets: table<name: string, path: string>,
  notes_root: string
] {
  if ($path | str starts-with $"($notes_root)/") {
    let relative = ($path | str replace $"($notes_root)/" '')

    let matched = ($targets
      | where {|target|
        ($relative | str starts-with $"($target.name)/") or ($relative == $target.name)
      }
      | sort-by {|target| $target.name | str length } --reverse
      | first)

    if $matched != null { return $matched.name }
    return null
  }

  let matched = ($targets
    | where {|target| $path | str starts-with $"($target.path)/" }
    | sort-by {|target| $target.path | str length } --reverse
    | first)

  if $matched != null { $matched.name } else { null }
}
