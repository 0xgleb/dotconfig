# fj routing logic — returns { tool: string, args: list<string> }
# Extracted for testability; mod.nu resolves the vcs backend, calls fj-route,
# maps the tool through resolve-tool, then executes.
#
# VCS backend policy (see vcs-backend): graphite (`gt`) is only used in the orgs
# that actually use it — rainlanguage and st0x. Everywhere else, stack-style
# commands go to gitbutler (`but`) when it's installed, otherwise plain `git`.

# Where the dispatch lane runs, regardless of where it was launched from.
#
# The dispatcher is a router rather than a project worker, but it still files
# registry rows and resolves its roster project from its working directory.
# Started from a pane sitting in HOME it adopts HOME as its "project", which is
# not a real project — unknown project paths fail open and mint a self-claimed
# drainer role for a path nothing else drains. Pinning the root here means the
# launching pane's directory cannot decide it.
const dispatcher_root = "/Users/0xgleb/.config"

# orgs whose repos use graphite for stacked PRs
const graphite_orgs = [
  rainlanguage
  st0x
]

const gt_commands = [
  absorb
  bottom
  checkout
  co
  create
  delete
  demo
  down
  feedback
  fold
  get
  guide
  init
  ll
  ls
  modify
  move
  rename
  reorder
  restack
  squash
  ss
  submit
  sync
  top
  untrack
  up
]

const git_commands = [
  add
  bisect
  blame
  branch
  cherry-pick
  clean
  commit
  diff
  fetch
  log
  merge
  pull
  push
  rebase
  remote
  reset
  restore
  revert
  show
  stash
  status
  submodule
  switch
  tag
  worktree
]

# Route an `fj` invocation to a tool + args. Only the PASSTHROUGH space reaches
# here: commands with dedicated `export def` subcommands (check, clanker, take,
# issue, pr, md, infra) are intercepted by nushell before main calls fj-route
# (see mod.nu's dispatch model), so routing them here would be dead code.
#
#   <empty>           -> status
#   ui                -> gitui
#   do                -> the check/commit workflow
#   mut [..]          -> gt modify [..]   (stack verb, translated per backend)
#   <gt verb> [..]    -> gt
#   <git verb> [..]   -> git
#   help | --help|-h  -> help
#   anything else     -> unknown
export def fj-route [...args: string]: nothing -> record<tool: string, args: list<string>> {
  if ($args | length) == 0 {
    return { tool: "status", args: [] }
  }

  let verb = $args.0
  let rest = ($args | skip 1)

  match $verb {
    "ui" => { tool: "gitui", args: $rest }
    "do" => { tool: "do", args: $rest }
    "mut" => { tool: "gt", args: (["modify"] | append $rest) }
    "help" | "--help" | "-h" => { tool: "help", args: $rest }
    _ if $verb in $gt_commands => { tool: "gt", args: $args }
    _ if $verb in $git_commands => { tool: "git", args: $args }
    _ => { tool: "unknown", args: $args }
  }
}

# Resolve the version-control backend tool for a working directory.
#
#   "gt"  — repos under a graphite org (~/code/rainlanguage/*, ~/code/st0x/*)
#   "but" — any other repo currently managed by gitbutler (on a gitbutler/*
#           branch, which is the only state where the `but` CLI operates)
#   "git" — fallback when neither applies
#
# `but` being on PATH is NOT enough to pick the gitbutler backend: it's
# installed globally, so keying off availability routes every repo to `but`,
# and `but` then nags to run setup in repos it doesn't manage. The real signal
# is the one `but` itself gates on — HEAD sitting on a gitbutler/* branch.
#
# Pure: callers pass the cwd, the home prefix, and whether the repo is currently
# gitbutler-managed, so this stays testable without touching the environment.
export def vcs-backend [
  cwd: string               # absolute working directory
  home: string              # home directory prefix (e.g. $env.HOME)
  gitbutler_managed: bool   # whether HEAD is on a gitbutler/* branch
]: nothing -> string {
  let under_graphite_org = ($graphite_orgs | any {|org|
    $cwd | str starts-with $"($home)/code/($org)/"
  })
  if $under_graphite_org {
    "gt"
  } else if $gitbutler_managed {
    "but"
  } else {
    "git"
  }
}

# Verb translations from fj's graphite-flavoured stack commands to the
# equivalent gitbutler (`but`) command. GitButler has no stack cursor and a
# different vocabulary, so each entry replaces the leading verb with one or more
# tokens; trailing args are preserved. Verbs absent here have no faithful
# gitbutler equivalent (e.g. the up/down/top/bottom cursor moves) and are
# reported as unsupported rather than guessed at.
const but_translations = {
  ls: [status]
  ll: [status]
  modify: [amend]
  ss: [push all]
  submit: [push]
  sync: [pull]
  squash: [squash]
  absorb: [absorb]
  move: [move]
  reorder: [move]
  rename: [reword]
  create: [branch new]
  co: [apply]
  checkout: [apply]
  untrack: [unapply]
  restack: [pull]
  init: [setup]
}

# Verb translations for the plain-git fallback ("neither" graphite nor
# gitbutler). Only stack verbs with an unambiguous git equivalent are listed;
# the rest are unsupported on git.
const git_translations = {
  modify: [commit --amend]
  ss: [push --force-with-lease]
  submit: [push]
  sync: [pull]
  co: [checkout]
  checkout: [checkout]
  create: [checkout -b]
  rename: [branch -m]
}

# Translate a routed stack command (tool "gt") to the active backend, mapping
# both the tool and the verb. Non-stack routes pass through unchanged.
#
#   backend "gt"  -> route unchanged (graphite already speaks these verbs)
#   backend "but" -> { tool: "but", args: <translated> } or "unsupported"
#   backend "git" -> { tool: "git", args: <translated> } or "unsupported"
#
# "unsupported" carries [verb, backend] so callers can print a clear error.
export def resolve-stack [
  route: record<tool: string, args: list<string>>
  backend: string
]: nothing -> record<tool: string, args: list<string>> {
  if $route.tool != "gt" or $backend == "gt" {
    return $route
  }

  let verb = ($route.args | first)
  let rest = ($route.args | skip 1)
  let table = if $backend == "but" { $but_translations } else { $git_translations }
  let mapped = ($table | get -o $verb)

  if $mapped == null {
    { tool: "unsupported", args: [$verb $backend] }
  } else {
    { tool: $backend, args: ($mapped | append $rest) }
  }
}

# Whether a routed command would force-push a protected branch on the non-graphite
# backends. `fj ss` translates to `git push --force-with-lease` (git) / `but push
# all` (but); on master/main that rewrites a protected branch, which the global
# rules forbid and which `ss` ("submit") does not advertise. Graphite manages its
# own stack branches, so the `gt` backend is left alone. Pure: the caller passes
# the current branch.
export def protected-push-blocked [
  raw: record<tool: string, args: list<string>>
  backend: string
  current_branch: string
]: nothing -> bool {
  let verb = ($raw.args | first | default "")
  ($raw.tool == "gt") and ($verb == "ss") and ($backend in ["git" "but"]) and ($current_branch in ["master" "main"])
}

# Encode an absolute path the way Claude Code names its per-directory
# session store under ~/.claude/projects/: every non-alphanumeric
# character (slash, dot, underscore) collapses to a dash. So
# /Users/x/.config becomes -Users-x--config. Claude keys sessions by
# absolute path, so a renamed or moved directory has no store and
# nothing to --continue, which is what `clanker` probes for.
export def claude-project-dirname [path: string]: nothing -> string {
  $path | str replace --all --regex '[^a-zA-Z0-9]' '-'
}

export def pi-project-dirname [path: string]: nothing -> string {
  let safe = (
    $path
    | str replace --regex '^[\\/]' ''
    | str replace --all --regex '[\\/:]' '-'
  )
  $"--($safe)--"
}

def session-args [has_session: bool, start_fresh: bool, resume_flags: list<string>, args: list<string>]: nothing -> list<string> {
  let steers_session = ($args | any {|arg| $arg in $resume_flags })
  if $has_session and not ($start_fresh or $steers_session) { ["--continue"] } else { [] }
}

# The tier a `--worker` session drops to on the Pi harness. Claude Code drops
# from Fable to Opus; Pi runs GPT-5.6 Sol, which is its own frontier, so the
# flag names it explicitly rather than inheriting whatever the session default
# happens to be.
const pi_worker_model = "openai-codex/gpt-5.6-sol"

# The standing mandate every project worker starts with, kept here rather than
# in each pane definition so the fleet cannot drift into per-worker variants of
# the same instruction. A resuming session already has it and would only be
# re-instructed mid-conversation, so the mandate rides a fresh session only.
def worker-prompt [
  wants_worker: bool
  project: string
  resume: list<string>
]: nothing -> list<string> {
  if not $wants_worker or ($resume | is-not-empty) {
    return []
  }
  let subject = if ($project | is-empty) { "project" } else { $project }
  [$"/register 15m You are the ($subject) worker. Drain the ($subject) queue per the register skill at 15m cadence. Delegate bounded read-only research to grok 4.5 cursor-agent workers freely."]
}

# The --claude and --new selectors are consumed from the rest args rather than
# declared as switches: the `clanker` wrapper is --wrapped, so user flags reach
# this command as runtime strings via spread, which nushell never re-parses
# into declared flags.
export def --wrapped clanker-route [
  pi_has_session: bool
  claude_has_session: bool
  --remote-control
  --project: string = "" # project name the worker mandate is written for
  ...args: string
]: nothing -> record<tool: string, args: list<string>> {
  let wants_claude = ("--claude" in $args)
  let wants_dispatcher = ("--dispatcher" in $args)
  let wants_worker = ("--worker" in $args)
  let start_fresh = ("--new" in $args)
  let forwarded = ($args | where {|arg| $arg not-in ["--claude" "--new" "--dispatcher" "--worker"] })
  if $wants_dispatcher {
    let resume = (session-args $pi_has_session $start_fresh ["--continue" "-c" "--resume" "-r" "--session" "--session-id" "--fork"] $forwarded)
    let prompt = if ($forwarded | is-empty) and ($resume | is-empty) {
      ["/loop 10m /register"]
    } else {
      []
    }
    return {
      tool: "pi-dispatcher"
      cwd: $dispatcher_root
      args: (
        ["--model" "ollama/qwen3.5:9b"]
        | append $resume
        | append $forwarded
        | append $prompt
      )
    }
  }
  if $wants_claude {
    let resume = (session-args $claude_has_session $start_fresh ["--continue" "-c" "--resume" "-r" "--from-pr"] $forwarded)
    let remote = if $remote_control { ["--remote-control"] } else { [] }
    let tier = if $wants_worker { ["--model" "opus"] } else { [] }
    let mandate = (worker-prompt $wants_worker $project $resume)
    {
      tool: "claude"
      args: ([
        "--settings"
        '{"effortLevel": "high", "enableWorkflows": true, "tui": "fullscreen"}'
        "--permission-mode"
        "auto"
      ] | append $remote | append $tier | append $resume | append $forwarded | append $mandate)
    }
  } else {
    let resume = (session-args $pi_has_session $start_fresh ["--continue" "-c" "--resume" "-r" "--session" "--session-id" "--fork"] $forwarded)
    let tier = if $wants_worker { ["--model" $pi_worker_model] } else { [] }
    let mandate = (worker-prompt $wants_worker $project $resume)
    {
      tool: "pi"
      args: (["--thinking" "high"] | append $tier | append $resume | append $forwarded | append $mandate)
    }
  }
}
