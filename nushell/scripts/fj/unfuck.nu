use log.nu

# Detect which unfuck operations are needed for the current repo.
# Returns a list of { action: string, description: string } records.
export def detect-issues []: nothing -> list<record<action: string, description: string>> {
  let worktree_path = (git rev-parse --show-toplevel | str trim)
  let git_common = (git rev-parse --git-common-dir | str trim)
  let main_root = if ($git_common | path basename) == ".git" {
    $git_common | path dirname
  } else {
    $git_common | path dirname | path dirname
  }
  let is_worktree = ($worktree_path | path expand) != ($main_root | path expand)

  mut issues = []

  if $is_worktree {
    let lib_dir = $main_root | path join "lib"
    if ($lib_dir | path exists) {
      let wt_lib = $worktree_path | path join "lib"
      let needs_fix = if not ($wt_lib | path exists) {
        true
      } else {
        let entries = (ls $wt_lib | where type == "symlink")
        $entries | is-empty
      }
      if $needs_fix {
        $issues = ($issues | append { action: "fix-submodules", description: "fix broken submodule symlinks in lib/" })
      }
    }
  }

  let typechanges = (git status --porcelain
    | lines
    | where {|line| ($line | str substring 0..2 | str contains "T") }
    | each {|line| $line | str substring 3.. | str trim })
  for file in $typechanges {
    $issues = ($issues | append { action: $"restore-symlink:($file)", description: $"restore ($file) symlink from master" })
  }

  $issues
}

# Fix broken submodule symlinks in a worktree.
def fix-submodules [] {
  let worktree_path = (git rev-parse --show-toplevel | str trim)
  let git_common = (git rev-parse --git-common-dir | str trim)
  let main_root = if ($git_common | path basename) == ".git" {
    $git_common | path dirname
  } else {
    $git_common | path dirname | path dirname
  }

  let lib_dir = $main_root | path join "lib"
  let submodules = (ls $lib_dir | where type == dir or type == symlink | get name | each { path basename })

  let wt_lib = $worktree_path | path join "lib"
  rm -rf $wt_lib
  mkdir $wt_lib

  let stripped = ($wt_lib | str replace $"($main_root)/" "")
  let component_count = ($stripped | split row "/" | length)
  let prefix = (1..$component_count | each { ".." } | str join "/")

  for sub in $submodules {
    let link_target = $"($prefix)/lib/($sub)"
    let link_path = $wt_lib | path join $sub
    ^ln -sfn $link_target $link_path
    log info $"symlinked ($sub) -> ($link_target)"
  }

  let git_tracked = (git -C $worktree_path ls-tree --name-only HEAD lib/ | lines | where { $in != "" })
  if not ($git_tracked | is-empty) {
    $git_tracked | each { git -C $worktree_path update-index --assume-unchanged $in }
    log info $"marked ($git_tracked | length) entries as assume-unchanged"
  }
}

# Restore a file as a symlink from master.
def restore-symlink [file: string] {
  git checkout master -- $file
  log info $"restored ($file) from master"
}

# Run all detected unfuck operations.
export def run [] {
  let issues = (detect-issues)

  if ($issues | is-empty) {
    return
  }

  print $"found ($issues | length) thing\(s) to unfuck:"
  $issues | each {|i| print $"  - ($i.description)" }
  print ""

  for issue in $issues {
    if $issue.action == "fix-submodules" {
      fix-submodules
    } else if ($issue.action | str starts-with "restore-symlink:") {
      let file = ($issue.action | str replace "restore-symlink:" "")
      restore-symlink $file
    }
  }

  print $"\n(ansi green)unfucked ($issues | length) thing\(s)(ansi reset)"
}
