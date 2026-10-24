# Fix submodule symlinks in a git worktree.
# Can be run from the worktree that needs fixing, or from the main repo root with a path argument.

# Compute the relative ../ prefix from a worktree's lib/ directory back to the main repo root.
export def relative-prefix [
  main_root: string
  wt_lib: string
]: nothing -> string {
  let stripped = $wt_lib | str replace $"($main_root)/" ""
  let component_count = $stripped | split row "/" | length
  1..$component_count | each { ".." } | str join "/"
}

export def main [
  worktree_path?: path  # Path to the worktree to fix. Defaults to current directory.
] {
  let target = if $worktree_path != null { $worktree_path | path expand } else { $env.PWD }

  let git_common = ^git -C $target rev-parse --git-common-dir | str trim
  let main_root = if ($git_common | path basename) == ".git" {
    $git_common | path dirname
  } else {
    $git_common | path dirname | path dirname
  }

  let lib_dir = $main_root | path join "lib"
  if not ($lib_dir | path exists) {
    print $"No lib/ directory found in main repo \(($main_root)\)"
    return
  }

  let is_worktree = ($target | path expand) != ($main_root | path expand)
  if not $is_worktree {
    print ("Current directory is the main repo root, not a worktree."
      + " Pass a worktree path as argument.")
    return
  }

  let submodules = (ls $lib_dir
    | where type == dir or type == symlink
    | get name
    | each { path basename })
  if ($submodules | is-empty) {
    print "No submodules found in lib/"
    return
  }

  let wt_lib = $target | path join "lib"
  rm -rf $wt_lib
  mkdir $wt_lib

  let prefix = relative-prefix $main_root $wt_lib

  for sub in $submodules {
    let link_target = $"($prefix)/lib/($sub)"
    let link_path = $wt_lib | path join $sub
    ^ln -sfn $link_target $link_path
    print $"  symlinked ($sub) -> ($link_target)"
  }

  let git_tracked = ^git -C $target ls-tree --name-only HEAD lib/ | lines | where { $in != "" }
  if not ($git_tracked | is-empty) {
    $git_tracked | each { ^git -C $target update-index --assume-unchanged $in }
    print $"\n  Marked ($git_tracked | length) entries as assume-unchanged"
  }

  print $"\nDone. Fixed ($submodules | length) submodule symlinks in ($target)"
}
