# fj routing logic — returns { tool: string, args: list<string> }
# Extracted for testability; mod.nu resolves the vcs backend, calls fj-route,
# maps the tool through resolve-tool, then executes.
#
# VCS backend policy (see vcs-backend): graphite (`gt`) is only used in the orgs
# that actually use it — rainlanguage and st0x. Everywhere else, stack-style
# commands go to gitbutler (`but`) when it's installed, otherwise plain `git`.

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

# Encode an absolute path the way Claude Code names its per-directory
# session store under ~/.claude/projects/: every non-alphanumeric
# character (slash, dot, underscore) collapses to a dash. So
# /Users/x/.config becomes -Users-x--config. Claude keys sessions by
# absolute path, so a renamed or moved directory has no store and
# nothing to --continue, which is what `clanker` probes for.
export def claude-project-dirname [path: string]: nothing -> string {
  $path | str replace --all --regex '[^a-zA-Z0-9]' '-'
}

# Build the claude argv for `fj clanker` from the user's extra args.
#
# clanker always launches with ultracode + auto permission mode + the
# flicker-free fullscreen TUI. On top of that it implicitly resumes the
# most recent session here (claude --continue), since picking up where
# you left off is the common case. The implicit --continue is dropped:
#
#   has_session false   no resumable conversation exists for this dir,
#                       so --continue would only error ("No conversation
#                       found to continue") — start fresh instead
#   --new               explicit fresh start; the flag is consumed here
#                       (not forwarded) and no --continue is added
#   -c/-r/--continue/   you are already steering session selection, so
#   --resume/--from-pr  the implicit --continue is dropped to avoid a
#                       conflict with the flag you passed
#
# Every other arg (e.g. an initial prompt) passes through to claude.
#
# Pure: the session probe is hoisted to the caller (has_session) so the
# resume logic stays testable without filesystem access or execing.
export def --wrapped clanker-args [
  has_session: bool   # whether claude has a resumable session for the cwd
  ...args: string
]: nothing -> list<string> {
  let resume_flags = ["--continue" "-c" "--resume" "-r" "--from-pr"]
  let steers_session = ($args | any {|a| $a in $resume_flags })
  let start_fresh = (("--new" in $args) or (not $has_session))
  let add_continue = (not ($start_fresh or $steers_session))
  let resume = if $add_continue { ["--continue"] } else { [] }
  let forwarded = ($args | where { $in != "--new" })

  [
    "--settings"
    '{"ultracode": true, "tui": "fullscreen"}'
    "--permission-mode"
    "auto"
  ]
  | append $resume
  | append $forwarded
}
