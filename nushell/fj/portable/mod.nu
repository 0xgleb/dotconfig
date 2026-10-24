use routing.nu [vcs-backend]
use gh.nu
use help.nu
use completions.nu [fj-complete]

# No shell interpolation: arguments cross into external commands as a list.
def checked-git [args: list<string>]: nothing -> string {
  let result = (do { ^git ...$args } | complete)
  if $result.exit_code != 0 {
    error make --unspanned {msg: $"git failed: ($result.stderr | str trim)"}
  }
  $result.stdout
}

def topology-paths [raw: string, current: string]: nothing -> list<string> {
  let separator = $"(char nul)(char nul)"
  if not ($raw | str ends-with $separator) {
    error make --unspanned {msg: "invalid Git topology: incomplete records"}
  }
  let records = ($raw | split row $separator)
  if ($records | last) != "" {
    error make --unspanned {msg: "invalid Git topology: trailing record bytes"}
  }
  let paths = ($records | drop 1 | each {|record|
    let fields = ($record | split row (char nul))
    if ($fields | length) < 2 or not ($fields.0 | str starts-with "worktree /") {
      error make --unspanned {msg: "invalid Git topology: missing worktree path"}
    }
    if ($fields | where {|f| $f | str starts-with "worktree "} | length) != 1 {
      error make --unspanned {msg: "invalid Git topology: duplicate worktree field"}
    }
    let path = ($fields.0 | str substring 9..)
    let heads = ($fields | where {|f| $f | str starts-with "HEAD "})
    let branches = ($fields | where {|f| $f | str starts-with "branch "})
    for marker in [bare detached] {
      if ($fields | where {|f| $f == $marker} | length) > 1 {
        error make --unspanned {msg: "invalid Git topology: duplicate marker"}
      }
    }
    if "bare" in $fields {
      if $path == $current or ($heads | is-not-empty) or ($branches | is-not-empty) or "detached" in $fields {
        error make --unspanned {msg: "invalid Git topology: inconsistent bare record"}
      }
    } else {
      if ($heads | length) != 1 or not ($heads.0 =~ '^HEAD ([0-9a-f]{40}|[0-9a-f]{64})$') {
        error make --unspanned {msg: "invalid Git topology: missing or malformed HEAD"}
      }
      if "detached" in $fields {
        if ($branches | is-not-empty) { error make --unspanned {msg: "invalid Git topology: detached branch"} }
      } else if ($branches | length) != 1 or not ($branches.0 =~ '^branch refs/heads/.+$') {
        error make --unspanned {msg: "invalid Git topology: missing branch"}
      }
    }
    $path
  })
  if ($paths | is-empty) or (($paths | uniq | length) != ($paths | length)) {
    error make --unspanned {msg: "invalid Git topology: empty or duplicate worktrees"}
  }
  $paths
}

def status [] {
  let top = (checked-git [rev-parse --show-toplevel] | str trim --right --char "\n")
  let topology = (topology-paths (checked-git [worktree list --porcelain -z]) $top)
  if $top not-in $topology {
    error make --unspanned {msg: "invalid Git topology: current worktree not listed"}
  }
  let main = $topology.0
  # Linked worktrees never even probe But. Detached HEAD is unmanaged.
  if $top != $main {
    print --no-newline (checked-git [status])
    return
  }
  let branch = (do { ^git symbolic-ref --quiet --short HEAD } | complete)
  if $branch.exit_code not-in [0 1] {
    error make --unspanned {msg: $"Git branch discovery failed: ($branch.stderr | str trim)"}
  }
  let managed = ($branch.exit_code == 0 and ($branch.stdout | str starts-with "gitbutler/"))
  let backend = (vcs-backend $env.PWD "" $managed true)
  if $backend == "but" {
    let result = (do { ^but status } | complete)
    if $result.exit_code != 0 {
      error make --unspanned {msg: $"but status failed: ($result.stderr | str trim)"}
    }
    print --no-newline $result.stdout
  } else {
    print --no-newline (checked-git [status])
  }
}

export def --wrapped main [...args: string@fj-complete] {
  if ($args | is-empty) { status; return }
  if $args.0 in [help --help -h] {
    if ($args | length) > 2 { error make --unspanned {msg: "usage: fj help [issue|pr]"} }
    help show ($args | get -o 1)
    return
  }
  # This also handles runtime-spread invocations from the packaged script.
  match ($args | first 2) {
    [issue list] => { gh issue-list ...($args | skip 2) }
    [pr list] => { gh pr-list ...($args | skip 2) }
    [issue view] | [pr view] => {
      let tail = ($args | skip 2)
      let ids = ($tail | where {|arg| $arg not-in [--web -w --comments -c]})
      if ($ids | length) > 1 or ($ids | any {|id| $id | str starts-with "-"}) {
        error make --unspanned {msg: "usage: fj issue view <id> or fj pr view [id], with --web/--comments"}
      }
      let web = ($tail | any {|arg| $arg in [--web -w]})
      let comments = ($tail | any {|arg| $arg in [--comments -c]})
      if $args.0 == "issue" {
        if ($ids | is-empty) { error make --unspanned {msg: "issue view requires an id"} }
        gh issue-view $ids.0 --web=$web --comments=$comments
      } else { gh pr-view ($ids | get -o 0) --web=$web --comments=$comments }
    }
    _ => { error make --unspanned {msg: "command not included in portable fj; use fj help"} }
  }
}

export def --wrapped "issue list" [...args: string] { gh issue-list ...$args }
export def "issue view" [id: string, --web (-w), --comments (-c)] {
  gh issue-view $id --web=$web --comments=$comments
}
export def --wrapped "pr list" [...args: string] { gh pr-list ...$args }
export def "pr view" [id?: string, --web (-w), --comments (-c)] {
  gh pr-view $id --web=$web --comments=$comments
}
