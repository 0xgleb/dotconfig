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
  let gitbutler_managed = (
    (which but | is-not-empty) and ($current_branch | str starts-with "gitbutler/")
  )
  let backend = (vcs-backend $env.PWD $env.HOME $gitbutler_managed)

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

# Launch Pi with high thinking and classified workflows. Pass `--claude` for
# Claude Code's high-effort Auto Mode, or `--dispatcher` for a Pi session on the
# local Ollama model that loops the shared dispatcher skill (ollama serve is
# started on demand). All modes resume the current project by default when a
# session exists; `--new` forces a fresh session.
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
    "pi-dispatcher" => {
      ensure-ollama
      cd $route.cwd
      ^pi ...$route.args
    }
    "claude" => { ^claude ...$route.args }
  }
}

# Start the local Ollama server on demand and wait until it answers. The
# daemon is detached from this shell so the dispatcher session survives
# shell exits; it is a no-op when a server is already listening.
def ensure-ollama [] {
  let alive = {||
    try {
      http get --max-time 2sec http://127.0.0.1:11434/api/version | ignore
      true
    } catch { false }
  }
  if (do $alive) { return }
  ^sh -c "nohup env OLLAMA_CONTEXT_LENGTH=40960 OLLAMA_KEEP_ALIVE=-1 ollama serve >/tmp/ollama-serve.log 2>&1 &"
  mut ready = false
  for _attempt in 1..30 {
    if (do $alive) { $ready = true; break }
    sleep 500ms
  }
  if not $ready {
    error make {msg: "ollama serve did not become ready; see /tmp/ollama-serve.log"}
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
