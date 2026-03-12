# Discover all sync targets: main repos + their git worktrees.
# Returns a table with {name, path} rows.
# "name" is the notes subdirectory (e.g. "liquidity/worktrees/untouchable")
# "path" is the absolute filesystem path to the repo/worktree
# https://www.nushell.sh/commands/docs/each.html
# https://www.nushell.sh/commands/docs/glob.html
def build-targets [org_root: string, repos: list<string>] {
  let main_targets = ($repos | each {|repo|
    { name: $repo, path: $"($org_root)/st0x.($repo)" }
  })

  # Scan .worktrees/ for 1-deep and 2-deep dirs (e.g. feat/name/)
  # glob returns absolute paths; compact drops nulls from the if-branches
  # https://www.nushell.sh/commands/docs/compact.html
  # https://www.nushell.sh/commands/docs/flatten.html
  let worktree_targets = ($repos | each {|repo|
    let worktree_dir = $"($org_root)/st0x.($repo)/.worktrees"

    if ($worktree_dir | path exists) {
      # glob only takes one pattern, so call twice and append
      (glob $"($worktree_dir)/*/" | append (glob $"($worktree_dir)/*/*/"))
        | each {|worktree_path|
          let worktree_path = ($worktree_path | str trim --right --char '/')

          # Only include dirs that are actual git worktrees
          if ($"($worktree_path)/.git" | path exists) {
            let leaf_name = ($worktree_path | path basename)
            { name: $"($repo)/worktrees/($leaf_name)", path: $worktree_path }
          }
          # when the if is false, each produces null -- compact strips these
        }
        | compact
    }
  } | flatten | compact)

  $main_targets | append $worktree_targets
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

  $git_files | append $local_files
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

    print $"[($timestamp)] [st0x.($repo_name) --new--> notes] ($repo_name)/($note_file)"
    cp $source $destination

  } else if (open --raw $source) != (open --raw $destination) {
    # ls -l returns a table with a `modified` column (datetime)
    # https://www.nushell.sh/commands/docs/ls.html
    let source_modified = (ls -l $source | first | get modified)
    let destination_modified = (ls -l $destination | first | get modified)

    if $source_modified > $destination_modified {
      let stats = (diff-stats $destination $source)
      print $"[($timestamp)] [st0x.($repo_name) --+($stats.adds),-($stats.dels)--> notes] ($repo_name)/($note_file)"
      cp $source $destination
    } else {
      let stats = (diff-stats $source $destination)
      print $"[($timestamp)] [notes --+($stats.adds),-($stats.dels)--> st0x.($repo_name)] ($repo_name)/($note_file)"
      cp $destination $source
    }
  }
}

# Sync all markdown files from a repo into its notes subdirectory.
# .local/ prefix is stripped so .local/prompts/x.md -> prompts/x.md in notes
# `$in` refers to the pipeline input -- here it's the result of str replace
# https://www.nushell.sh/book/pipelines.html#pipeline-input-and-the-in-variable
def sync-repo [repo_path: string, repo_name: string, notes_root: string] {
  if not ($repo_path | path exists) { return }

  let repo_notes = $"($notes_root)/($repo_name)"
  mkdir $repo_notes

  md-files $repo_path | each {|file|
    # str replace strips ".local/" prefix, then undot strips leading dots
    # `$in` captures the pipeline result of str replace as input to undot
    let note_file = ($file | str replace '.local/' '' | undot $in)
    let source = $"($repo_path)/($file)"
    let destination = $"($repo_notes)/($note_file)"

    sync-file $source $destination $repo_name $note_file
  }

  # each returns a list of results; null discards it
  # https://www.nushell.sh/book/pipelines.html
  null
}

# Iterate over all targets and sync each one
def sync-all [targets: table<name: string, path: string>, notes_root: string] {
  $targets | each {|target|
    sync-repo $target.path $target.name $notes_root
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
