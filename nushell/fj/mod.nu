use routing.nu [
  fj-route
  vcs-backend
  resolve-stack
  clanker-args
  claude-project-dirname
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
  check run
}

# launch claude code in ultracode (xhigh effort + standing workflow
# orchestration), auto permission mode, and flicker-free rendering. resumes the
# most recent session here by default, but only when one actually exists;
# otherwise (fresh, renamed, or moved dir) it starts fresh instead of erroring.
# pass `--new` to force a fresh start. see `clanker-args` for the full rules.
export def --wrapped clanker [...args: string] {
  let dirname = (claude-project-dirname $env.PWD)
  let project_dir = $"($env.HOME)/.claude/projects/($dirname)"
  let has_session = (
    ($project_dir | path exists)
    and ((glob $"($project_dir)/*.jsonl") | is-not-empty)
  )
  ^claude ...(clanker-args $has_session ...$args)
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
