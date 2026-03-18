use std/log

const DEFAULT_CONFIG_PATH = "~/.config/mdaemon.nuon"

def load-config [path: string] {
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
def build-targets [org_root: string, exclude: string = ""] {
  let repos = (glob $"($org_root)/*" --no-file --no-symlink
    | where {|dir|
      let name = ($dir | path basename)
      let is_excluded = if $exclude != "" {
        ($dir | str starts-with $exclude) or ($exclude | str starts-with $dir)
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

def build-all-targets [config: record] {
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
# https://www.nushell.sh/commands/docs/complete.html -- captures exit code + stdout/stderr
# https://www.nushell.sh/commands/docs/where.html
def md-files [repo_path: string] {
  # `do { } | complete` runs the command and captures result as a record
  # instead of failing on non-zero exit. We pull stdout and filter to .md
  let git_files = (do { git -C $repo_path ls-tree -r --name-only HEAD }
    | complete
    | get stdout
    | lines
    | where ($it | str ends-with '.md'))

  let local_dir = $"($repo_path)/.local"

  # .local/ files are gitignored, so we glob the filesystem directly
  # str replace strips the repo prefix to get relative paths
  # https://www.nushell.sh/commands/docs/str_replace.html
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
# Pipelines: split into segments, transform each, rejoin
# https://www.nushell.sh/commands/docs/split_row.html
# https://www.nushell.sh/commands/docs/str_trim.html
def undot [path: string] {
  $path
    | split row '/'
    | each {|segment| $segment | str trim --left --char '.' }
    | str join '/'
}

# Count additions/deletions between two files using unix diff.
# Returns a record like { adds: 3, dels: 1 }
# https://www.nushell.sh/book/types_of_data.html#records
def diff-stats [source: string, destination: string] {
  # diff exits non-zero when files differ -- `do { } | complete` prevents failure
  let diff_output = (do { diff $source $destination } | complete | get stdout | lines)

  let additions = ($diff_output | where ($it | str starts-with '>') | length)
  let deletions = ($diff_output | where ($it | str starts-with '<') | length)

  { adds: $additions, dels: $deletions }
}

# Atomically copy a file: write to a temp sibling, then rename.
# Prevents partial writes from corrupting the destination.
def atomic-cp [source: string, destination: string] {
  let tmp = $"($destination).md-sync-tmp"
  cp $source $tmp
  let src_hash = (open --raw $source | hash md5)
  let tmp_hash = (open --raw $tmp | hash md5)
  if $src_hash != $tmp_hash {
    rm $tmp
    error make { msg: $"copy verification failed: ($source) -> ($destination)" }
  }
  mv --force $tmp $destination
}

# Refuse to sync when the "newer" file is empty but the older has real content.
# This catches truncation bugs, failed writes, and editor save errors.
def guard-empty-overwrite [newer: string, older: string] {
  let newer_size = (ls -l $newer | first | get size | into int)
  let older_size = (ls -l $older | first | get size | into int)
  if $newer_size == 0 and $older_size > 0 {
    error make { msg: $"refusing to overwrite non-empty file with empty file: ($newer) -> ($older)" }
  }
}

# Bidirectional sync of a single file. Newer file wins.
# - Missing destination: copy source (repo -> notes)
# - Contents differ: compare mtime, copy the newer one over the older
# - Identical: no-op
# https://www.nushell.sh/commands/docs/open.html -- `open --raw` reads as raw bytes
def sync-file [source: string, destination: string, repo_name: string, note_file: string] {
  let timestamp = (date now | format date '%H:%M:%S')

  if not ($destination | path exists) {
    let parent_dir = ($destination | path dirname)
    mkdir $parent_dir

    print $"[($timestamp)] [($repo_name) --new--> notes] ($repo_name)/($note_file)"
    atomic-cp $source $destination

  } else if (open --raw $source) != (open --raw $destination) {
    # ls -l returns a table with a `modified` column (datetime)
    # https://www.nushell.sh/commands/docs/ls.html
    let source_modified = (ls -l $source | first | get modified)
    let destination_modified = (ls -l $destination | first | get modified)

    if $source_modified > $destination_modified {
      guard-empty-overwrite $source $destination
      let stats = (diff-stats $destination $source)
      print $"[($timestamp)] [($repo_name) --+($stats.adds),-($stats.dels)--> notes] ($repo_name)/($note_file)"
      atomic-cp $source $destination
    } else {
      guard-empty-overwrite $destination $source
      let stats = (diff-stats $source $destination)
      print $"[($timestamp)] [notes --+($stats.adds),-($stats.dels)--> ($repo_name)] ($repo_name)/($note_file)"
      atomic-cp $destination $source
    }
  }
}

# Sync all markdown files from a repo into its notes subdirectory.
# .local/ prefix is stripped so .local/prompts/x.md -> prompts/x.md in notes
# `$in` refers to the pipeline input -- here it's the result of str replace
# https://www.nushell.sh/book/pipelines.html#pipeline-input-and-the-in-variable
def sync-repo [repo_path: string, repo_name: string, notes_root: string] {
  if not ($repo_path | path exists) {
    log warning $"($repo_name): path ($repo_path) does not exist, skipping"
    return
  }

  let repo_notes = $"($notes_root)/($repo_name)"
  mkdir $repo_notes

  let files = (md-files $repo_path)
  log info $"($repo_name): ($files | length) md files"

  let errors = ($files | each {|file|
    let note_file = ($file | str replace '.local/' '' | undot $in)
    let source = $"($repo_path)/($file)"
    let destination = $"($repo_notes)/($note_file)"

    try {
      sync-file $source $destination $repo_name $note_file
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
# Errors in one repo don't prevent syncing others.
def sync-all [targets: table<name: string, path: string>, notes_root: string] {
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
# Handles both directions:
#   - notes path -> strip notes_root, match against target names
#   - repo path  -> match against target paths
# Longest match wins (worktree paths are more specific than main repo paths)
# https://www.nushell.sh/commands/docs/sort-by.html
def repo-for-path [
  path: string,
  targets: table<name: string, path: string>,
  notes_root: string
] {
  # Notes path: strip the notes root, match by target name prefix
  if ($path | str starts-with $"($notes_root)/") {
    let relative = ($path | str replace $"($notes_root)/" '')

    # where with a closure: {|target| ...} filters the table
    # sort-by longest name first so worktree matches beat main repo
    let matched = ($targets
      | where {|target| ($relative | str starts-with $"($target.name)/") or ($relative == $target.name) }
      | sort-by {|target| $target.name | str length } --reverse
      | first)

    if $matched != null { return $matched.name }
    return null
  }

  # Repo path: match by target path prefix, longest wins
  let matched = ($targets
    | where {|target| $path | str starts-with $"($target.path)/" }
    | sort-by {|target| $target.path | str length } --reverse
    | first)

  if $matched != null { $matched.name } else { null }
}
