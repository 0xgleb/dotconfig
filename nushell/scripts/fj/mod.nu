use routing.nu [fj-route vcs-backend resolve-stack]
use check.nu
use unfuck.nu
use workflow.nu
use completions.nu [fj-complete issue-complete pr-complete]
use gh.nu
use help.nu
use md/
use infra/
export use md/
export use infra/

# unified dev command — run `fj help` for details
export def --wrapped main [...args: string@fj-complete] {
  let raw = (fj-route ...$args)
  let gitbutler_managed = (
    (which but | is-not-empty) and (
      (do { ^git rev-parse --abbrev-ref HEAD } | complete | get stdout | str trim)
      | str starts-with "gitbutler/"
    )
  )
  let backend = (vcs-backend $env.PWD $env.HOME $gitbutler_managed)
  let route = (resolve-stack $raw $backend)
  match $route.tool {
    "status" => {
      match $backend {
        "but" => { try { ^but status } catch { ^git status } }
        _ => {
          ^git status
          if $backend == "gt" { try { ^gt ls -a } }
        }
      }
    }
    "gitui" => { ^gitui ...$route.args }
    "gt" => { ^gt ...$route.args }
    "but" => { ^but ...$route.args }
    "git" => { ^git ...$route.args }
    "unsupported" => {
      let verb = ($route.args | get 0)
      let be = ($route.args | get 1)
      error make --unspanned {
        msg: $"`fj ($verb)` has no equivalent on the ($be) backend in this repo"
      }
    }
    "do" => { workflow run }
    "check" => {
      unfuck run
      check run
    }
    "unfuck" => { unfuck run }
    "take" => {
      let version = ($route.args | get 0)
      let path = ($route.args | get 1)
      if $version not-in ["ours" "theirs"] {
        error make --unspanned { msg: $"version must be 'ours' or 'theirs', got '($version)'" }
      }
      ^git checkout $"--($version)" -- $path
      ^git add $path
      print $"(ansi green)resolved(ansi reset) ($path) -> ($version)"
    }
    "issue" => {
      if ($route.args | is-empty) {
        ^gh issue
      } else if $route.args.0 == "list" {
        ^gh issue list ...($route.args | skip 1)
      } else if $route.args.0 == "view" {
        let view_args = ($route.args | skip 1)
        let web = ("--web" in $view_args) or ("-w" in $view_args)
        let comments = ("--comments" in $view_args) or ("-c" in $view_args)
        let id = ($view_args | where { $in not-in ["--web" "-w" "--comments" "-c"] } | first)
        gh issue-view $id --web=$web --comments=$comments
      } else {
        ^gh issue ...$route.args
      }
    }
    "pr" => {
      if ($route.args | is-empty) {
        ^gh pr
      } else if $route.args.0 == "list" {
        ^gh pr list ...($route.args | skip 1)
      } else if $route.args.0 == "view" {
        let view_args = ($route.args | skip 1)
        let web = ("--web" in $view_args) or ("-w" in $view_args)
        let comments = ("--comments" in $view_args) or ("-c" in $view_args)
        let positional = ($view_args | where { $in not-in ["--web" "-w" "--comments" "-c"] })
        let id = if ($positional | is-empty) { null } else { $positional | first }
        gh pr-view $id --web=$web --comments=$comments
      } else {
        ^gh pr ...$route.args
      }
    }
    "md" => { md dispatch $route.args }
    "infra" => { infra dispatch $route.args }
    "help" => {
      let topic = if ($route.args | is-empty) { null } else { $route.args | first }
      help show $topic
    }
    "unknown" => {
      let cmd = ($route.args | first)
      error make --unspanned { msg: $"unknown fj command: ($cmd)" }
    }
  }
}

# resolve a merge conflict — take ours or theirs, then stage
export def take [
  version: string    # "ours" or "theirs"
  path: string       # file with conflict
] {
  if $version not-in ["ours" "theirs"] {
    error make --unspanned { msg: $"version must be 'ours' or 'theirs', got '($version)'" }
  }
  ^git checkout $"--($version)" -- $path
  ^git add $path
  print $"(ansi green)resolved(ansi reset) ($path) -> ($version)"
}

# run repo-specific checks (auto-unfucks first)
export def check [] {
  unfuck run
  check run
}

# fix common repo issues (submodules, symlinks)
export def unfuck [] {
  unfuck run
}

# list github issues
export def --wrapped "issue list" [...args: string] {
  gh issue-list ...$args
}

# view issue in markdown format
export def "issue view" [id: string, --web (-w), --comments (-c)] {
  gh issue-view $id --web=$web --comments=$comments
}

# github issues (other subcommands pass through to gh)
export def --wrapped issue [...args: string@issue-complete] {
  ^gh issue ...$args
}

# list pull requests
export def --wrapped "pr list" [...args: string] {
  gh pr-list ...$args
}

# view PR in markdown format
export def "pr view" [id?: string, --web (-w), --comments (-c)] {
  gh pr-view $id --web=$web --comments=$comments
}

# pull requests (other subcommands pass through to gh)
export def --wrapped pr [...args: string@pr-complete] {
  ^gh pr ...$args
}
