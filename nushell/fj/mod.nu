use routing.nu [
  fj-route
  vcs-backend
  resolve-stack
  protected-push-blocked
  clanker-route
  claude-project-dirname
  pi-project-dirname
  dispatch_model
  dispatch_lane_environment
  local_dispatch_lane
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
  let project = if $env.PWD == $nu.home-dir { "home" } else { $env.PWD | path basename }
  let route = (clanker-route $pi_has_session $claude_has_session --remote-control=$on_nixxxos --project=$project ...$args)
  match $route.tool {
    "pi" => { ^pi ...$route.args }
    "pi-dispatcher" => {
      ensure-ollama
      cd $route.cwd
      # The launcher DECLARES dispatch-lane identity for the pinned session
      # rather than letting extensions infer it from `--model ollama/...`,
      # which any session could pick (see routing.nu's dispatch_lane_* consts
      # and ai/pi/extensions/shared/local-lane.ts's dispatchLane). Built via
      # `insert` rather than a record literal since the column name is a
      # variable, not a bare identifier.
      let dispatch_env = ({} | insert $dispatch_lane_environment $local_dispatch_lane)
      with-env $dispatch_env {
        ^pi ...$route.args
      }
    }
    "claude" => { ^claude ...$route.args }
  }
}

# Assert the dispatch-lane model tag is actually pulled. `ensure-ollama`'s
# readiness probe only confirms the daemon answers `/api/version`, which it
# does identically whether or not the tag exists — a missing tag then 404s on
# every completion the dispatch lane tries to route, and since that lane is
# the only drainer of the bridge inbox, the failure would otherwise surface an
# hour later as a silent expiry instead of here.
#
# Both callers run this immediately after the `alive` probe succeeds, but a
# daemon that answered `/api/version` can still stop responding, hang, or
# error before this request completes (it may be the Ollama app, a login
# item, or an earlier shell rather than the process this function just
# started) — so the request is wrapped the same way `alive` wraps its own
# probe, and a request failure raises the same crafted, actionable error
# rather than a raw HTTP exception.
def ensure-ollama-model [model: string] {
  let tags = (
    try {
      http get --max-time 5sec http://127.0.0.1:11434/api/tags
    } catch {
      error make --unspanned {
        msg: "could not reach ollama serve at http://127.0.0.1:11434 to verify the pulled model — is a server actually listening?"
      }
    }
  )
  let names = ($tags.models? | default [] | each {|entry|
    $entry.model? | default ($entry.name? | default "")
  })
  if $model not-in $names {
    error make --unspanned {
      msg: $"ollama does not have '($model)' pulled — run `ollama pull ($model)` and retry `fj clanker --dispatcher`."
    }
  }
}

# Ollama's OpenAI-compatible endpoint takes no per-request context length, so
# the routing prompt's fate depends entirely on the OLLAMA_CONTEXT_LENGTH the
# server was launched with. This function can only set that when it starts the
# daemon itself (below); a server already running — the Ollama app, a login
# item, an earlier shell — may be short. `/api/ps` reports the context window
# a loaded model is actually served with (see
# ai/pi/extensions/local-models/core.ts's `runningModels`/`parseServedContext`,
# which reads the same field), so this checks that before warning instead of
# assuming every already-running server is unverifiable: only a model that
# genuinely isn't loaded yet, or is loaded short, gets the warning.
def warn-ollama-context-unverified [model: string] {
  let served = (
    try {
      let ps = (http get --max-time 2sec http://127.0.0.1:11434/api/ps)
      let matches = ($ps.models? | default [] | where {|entry|
        ($entry.model? | default ($entry.name? | default "")) == $model
      })
      $matches.0.context_length?
    } catch { null }
  )
  if ($served != null) and ($served >= 40960) {
    return
  }
  print --stderr (
    $"(ansi yellow)warning(ansi reset): ollama serve was already running and its"
    + " served context window for the dispatch model could not be confirmed as"
    + " at least 40960 tokens. `fj clanker --dispatcher` needs that much context"
    + " for the dispatch model; if routing looks degraded (messages dropped,"
    + " wrong project), restart ollama serve with OLLAMA_CONTEXT_LENGTH=40960."
  )
}

# Start the local Ollama server on demand and wait until it answers. The
# daemon is detached from this shell so the dispatcher session survives
# shell exits. When a server is already listening this is a no-op beyond
# checking the dispatch model is pulled and warning about its context window,
# since only the branch that starts the daemon can set that window.
#
# The daemon this starts is launched with `OLLAMA_KEEP_ALIVE=-1`, which keeps
# the dispatch model resident in memory indefinitely rather than unloading it
# after Ollama's usual idle timeout — closing the dispatcher pane does not
# stop it or release the model. This function has no stop path (no
# `fj clanker --dispatcher-stop` or equivalent); that is out of scope here.
# Stopping the daemon and freeing the memory is a manual `pkill ollama` (or
# equivalent) outside this tool, and nothing in this file does it for you.
def ensure-ollama [] {
  let alive = {||
    try {
      http get --max-time 2sec http://127.0.0.1:11434/api/version | ignore
      true
    } catch { false }
  }
  if (do $alive) {
    ensure-ollama-model $dispatch_model
    warn-ollama-context-unverified $dispatch_model
    return
  }
  ^sh -c "nohup env OLLAMA_CONTEXT_LENGTH=40960 OLLAMA_KEEP_ALIVE=-1 ollama serve >/tmp/ollama-serve.log 2>&1 &"
  let ready = (seq 1 30 | any {|_|
    if (do $alive) { true } else { sleep 500ms; false }
  })
  if not $ready {
    error make {msg: "ollama serve did not become ready; see /tmp/ollama-serve.log"}
  }
  ensure-ollama-model $dispatch_model
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
