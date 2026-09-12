use routing.nu [
  fj-route
  vcs-backend
  resolve-stack
  protected-push-blocked
  clanker-route
  claude-project-dirname
  pi-project-dirname
]
use check.nu
use workflow.nu
use completions.nu [fj-complete issue-complete pr-complete]
use gh.nu
use help.nu
export use md.nu
export use infra.nu
export use cheatsheet.nu

# unified dev command — run `fj help` for details.
#
# Dispatch model: commands with typed flags, completions, or their own help
# (check, clanker, take, issue, pr, md, infra) are `export def` subcommands
# below. Nushell resolves `fj <those>` to the subcommand, which SHADOWS this
# `--wrapped main`, so main only ever runs for the passthrough space:
# no-args, ui, do, mut, the stack/git verbs, help, and unknowns. `fj-route`
# therefore handles only those — adding a subcommand def means routing it
# here is dead code.
export def --wrapped main [...args: string@fj-complete] {
  let raw = (fj-route ...$args)
  let current_branch = (
    try { do { ^git rev-parse --abbrev-ref HEAD } | complete | get stdout | str trim } catch { "" }
  )
  let current_top_level = (
    try { do { ^git rev-parse --show-toplevel } | complete | get stdout | str trim } catch { "" }
  )
  let main_top_level = (
    try {
      do { ^git worktree list --porcelain }
      | complete
      | get stdout
      | lines
      | where { $in | str starts-with "worktree " }
      | first
      | str replace "worktree " ""
    } catch { "" }
  )
  let is_main_worktree = (
    ($current_top_level | is-not-empty) and ($current_top_level == $main_top_level)
  )
  let gitbutler_managed = (
    (which but | is-not-empty) and ($current_branch | str starts-with "gitbutler/")
  )
  let backend = (vcs-backend $env.PWD $env.HOME $gitbutler_managed $is_main_worktree)

  if (protected-push-blocked $raw $backend $current_branch) {
    error make --unspanned {
      msg: ($"refusing `fj ss` on '($current_branch)': it force-pushes a protected"
        + $" branch on the ($backend) backend. Switch to a feature branch, or run"
        + " an explicit `git push` if you really mean to.")
    }
  }

  let route = (resolve-stack $raw $backend)
  match $route.tool {
    "status" => {
      match $backend {
        "but" => { try { ^but status } catch { ^git status } }
        _ => { ^git status }
      }
    }
    "gitui" => { ^gitui ...$route.args }
    "but" => { ^but ...$route.args }
    "git" => { ^git ...$route.args }
    "unsupported" => {
      let verb = ($route.args | get 0)
      let be = ($route.args | get 1)
      error make --unspanned {
        msg: $"`fj ($verb)` has no equivalent on the ($be) backend in this repo"
      }
    }
    "do" => { workflow execute }
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

# run repo-specific checks
export def check [] {
  check execute
}

# Launch Pi with high thinking and classified workflows. Pass `--claude` for
# Claude Code's high-effort Auto Mode. Both resume the current project by default
# when a session exists; `--new` forces a fresh session.
export def --wrapped clanker [...args: string] {
  let claude_dir = $"($env.HOME)/.claude/projects/(claude-project-dirname $env.PWD)"
  let pi_dir = $"($env.HOME)/.pi/agent/sessions/(pi-project-dirname $env.PWD)"
  let claude_has_session = (
    ($claude_dir | path exists)
    and ((glob $"($claude_dir)/*.jsonl") | is-not-empty)
  )
  let pi_has_session = (
    ($pi_dir | path exists)
    and ((glob $"($pi_dir)/*.jsonl") | is-not-empty)
  )
  let on_nixxxos = ((^hostname | str trim) == "nixxxos")
  let route = (clanker-route $pi_has_session $claude_has_session --remote-control=$on_nixxxos ...$args)
  match $route.tool {
    "pi" => { ^pi ...$route.args }
    "claude" => { ^claude ...$route.args }
  }
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
