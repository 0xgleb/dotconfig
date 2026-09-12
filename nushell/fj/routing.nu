# fj routing logic — returns { tool: string, args: list<string> }
# Extracted for testability; mod.nu resolves the vcs backend, calls fj-route,
# maps stack verbs through resolve-stack, then executes.
#
# Stack-style commands use GitButler only in a verified managed main worktree.
# All other repositories and linked worktrees use plain Git.

const stack_commands = [
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
#   mut [..]          -> stack modify [..] (translated per backend)
#   <stack verb> [..] -> stack
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
    "mut" => { tool: "stack", args: (["modify"] | append $rest) }
    "help" | "--help" | "-h" => { tool: "help", args: $rest }
    _ if $verb in $stack_commands => { tool: "stack", args: $args }
    _ if $verb in $git_commands => { tool: "git", args: $args }
    _ => { tool: "unknown", args: $args }
  }
}

# Resolve the version-control backend tool for a working directory.
#
#   "but" — a repo currently managed by GitButler, from its main worktree
#   "git" — every other repository and all linked worktrees
#
# `but` being on PATH is NOT enough to pick the GitButler backend: it is
# installed globally. A gitbutler/* branch identifies management only after the
# current top-level is proven to be the first/main worktree. Linked, isolated,
# and scratch worktrees always route to plain Git.
#
# Pure: callers pass topology evidence so this stays testable without touching
# the environment. Retain cwd/home arguments for caller compatibility; paths no
# longer select a special organization-specific backend.
export def vcs-backend [
  cwd: string               # absolute working directory
  home: string              # home directory prefix (e.g. $env.HOME)
  gitbutler_managed: bool   # whether HEAD is on a gitbutler/* branch
  is_main_worktree: bool    # whether current top-level is the first worktree
]: nothing -> string {
  if $gitbutler_managed and $is_main_worktree {
    "but"
  } else {
    "git"
  }
}

# Verb translations from fj's stack-style commands to the
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

# Verb translations for the plain-Git fallback. Only stack verbs with an
# unambiguous Git equivalent are listed;
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

# Translate a logical stack command to the active backend, mapping both the
# tool and the verb. Non-stack routes pass through unchanged.
#
#   backend "but" -> { tool: "but", args: <translated> } or "unsupported"
#   backend "git" -> { tool: "git", args: <translated> } or "unsupported"
#
# "unsupported" carries [verb, backend] so callers can print a clear error.
export def resolve-stack [
  route: record<tool: string, args: list<string>>
  backend: string
]: nothing -> record<tool: string, args: list<string>> {
  if $route.tool != "stack" {
    return $route
  }

  let verb = ($route.args | first)
  if $backend not-in ["but" "git"] {
    return { tool: "unsupported", args: [$verb $backend] }
  }
  let rest = ($route.args | skip 1)
  let table = if $backend == "but" { $but_translations } else { $git_translations }
  let mapped = ($table | get -o $verb)

  if $mapped == null {
    { tool: "unsupported", args: [$verb $backend] }
  } else {
    { tool: $backend, args: ($mapped | append $rest) }
  }
}

# Preserve the protected-branch guard for `fj ss`, which translates to
# `git push --force-with-lease` (git) / `but push all` (but).
# Pure: the caller passes the current branch.
export def protected-push-blocked [
  raw: record<tool: string, args: list<string>>
  backend: string
  current_branch: string
]: nothing -> bool {
  let verb = ($raw.args | first | default "")
  ($raw.tool == "stack") and ($verb == "ss") and ($backend in ["git" "but"]) and ($current_branch in ["master" "main"])
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

# The --claude and --new selectors are consumed from the rest args rather than
# declared as switches: the `clanker` wrapper is --wrapped, so user flags reach
# this command as runtime strings via spread, which nushell never re-parses
# into declared flags.
export def --wrapped clanker-route [
  pi_has_session: bool
  claude_has_session: bool
  --remote-control
  ...args: string
]: nothing -> record<tool: string, args: list<string>> {
  let wants_claude = ("--claude" in $args)
  let start_fresh = ("--new" in $args)
  let forwarded = ($args | where {|arg| $arg not-in ["--claude" "--new"] })
  if $wants_claude {
    let resume = (session-args $claude_has_session $start_fresh ["--continue" "-c" "--resume" "-r" "--from-pr"] $forwarded)
    let remote = if $remote_control { ["--remote-control"] } else { [] }
    {
      tool: "claude"
      args: ([
        "--settings"
        '{"effortLevel": "high", "enableWorkflows": true, "tui": "fullscreen"}'
        "--permission-mode"
        "auto"
      ] | append $remote | append $resume | append $forwarded)
    }
  } else {
    let resume = (session-args $pi_has_session $start_fresh ["--continue" "-c" "--resume" "-r" "--session" "--session-id" "--fork"] $forwarded)
    {
      tool: "pi"
      args: (["--thinking" "high"] | append $resume | append $forwarded)
    }
  }
}
