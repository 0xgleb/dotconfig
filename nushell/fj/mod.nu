use routing.nu [
  fj-route
  vcs-backend
  resolve-stack
  protected-push-blocked
  clanker-route
  claude-project-dirname
  pi-project-dirname
  pi-session-id-from-path
  live-pi-session-ids
  live-safe-pi-resume-route
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

export def process-is-alive [pid: int]: nothing -> bool {
  (do { ^kill -0 $pid } | complete).exit_code == 0
}

def active-pi-session-ids [cwd: string, home: string]: nothing -> list<string> {
  let database = $"($home)/.local/state/pi/agent-registry/registry.sqlite"
  if not ($database | path exists) { return [] }
  let escaped_cwd = ($cwd | str replace --all "'" "''")
  let now_ms = ((date now | format date "%s" | into int) * 1_000)
  let query = $"SELECT agent_id, pid FROM agents WHERE cwd = '($escaped_cwd)' AND expires_at > ($now_ms) ORDER BY agent_id;"
  let result = (do { ^sqlite3 -readonly -json $database $query } | complete)
  if $result.exit_code != 0 {
    error make { msg: "cannot verify active Pi sessions before resume" }
  }
  let output = ($result.stdout | str trim)
  if ($output | is-empty) { return [] }
  let agents = ($output | from json)
  let live_pids = (
    $agents
    | where {|agent| process-is-alive ($agent.pid | into int) }
    | get pid
    | each {|pid| $pid | into int }
  )
  live-pi-session-ids $agents $live_pids
}

def pi-session-ids-newest-first [pi_dir: string]: nothing -> list<string> {
  if not ($pi_dir | path exists) { return [] }
  let paths = (glob $"($pi_dir)/*.jsonl")
  if ($paths | is-empty) { return [] }
  ls ...$paths
  | sort-by modified --reverse
  | get name
  | each {|path| pi-session-id-from-path $path }
}

def live-safe-pi-resume [route: record, pi_dir: string, cwd: string, home: string]: nothing -> record {
  if ($route.tool != "pi") or (not ("--continue" in $route.args)) { return $route }
  live-safe-pi-resume-route (
    $route
  ) (pi-session-ids-newest-first $pi_dir) (active-pi-session-ids $cwd $home)
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
  let routed = (clanker-route $pi_has_session $claude_has_session --remote-control=$on_nixxxos --cwd $env.PWD --home $env.HOME ...$args)
  let route = (live-safe-pi-resume $routed $pi_dir $env.PWD $env.HOME)
  match $route.tool {
    "pi" => { ^pi ...$route.args }
    "pi-dispatcher" => { run-local-dispatcher $route.cwd $route.args }
    "claude" => { ^claude ...$route.args }
  }
}

# Run the explicitly selected local dispatcher with an Ollama server whose
# lifetime is owned by the dispatcher. Refuse a pre-existing server rather than
# risking another workload, then unload and stop only the server started here.
def run-local-dispatcher [cwd: string, args: list<string>] {
  let lifecycle = r#'
set -eu
cwd=$1
shift
server_pid=""
cleanup() {
  if [ -n "$server_pid" ] && kill -0 "$server_pid" 2>/dev/null; then
    ollama stop qwen3.5:9b >/dev/null 2>&1 || true
    kill "$server_pid" 2>/dev/null || true
    wait "$server_pid" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM HUP
if ollama list >/dev/null 2>&1; then
  echo "refusing local dispatcher: an Ollama server is already running" >&2
  exit 1
fi
env OLLAMA_CONTEXT_LENGTH=40960 OLLAMA_KEEP_ALIVE=5m ollama serve >/tmp/ollama-serve.log 2>&1 &
server_pid=$!
attempt=0
until ollama list >/dev/null 2>&1; do
  if ! kill -0 "$server_pid" 2>/dev/null; then
    echo "owned ollama serve exited before becoming ready" >&2
    exit 1
  fi
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 30 ]; then
    echo "ollama serve did not become ready; see /tmp/ollama-serve.log" >&2
    exit 1
  fi
  sleep 0.5
done
cd "$cwd"
pi "$@"
'#
  ^sh -c $lifecycle fj-local-dispatcher $cwd ...$args
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
