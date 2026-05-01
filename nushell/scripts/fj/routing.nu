# fj routing logic — returns { tool: string, args: list<string> }
# Extracted for testability; mod.nu calls this then executes.

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

export def fj-route [...args: string]: nothing -> record<tool: string, args: list<string>> {
  if ($args | length) == 0 {
    { tool: "status", args: [] }
  } else if $args.0 == "ui" {
    { tool: "gitui", args: ($args | skip 1) }
  } else if $args.0 == "do" {
    { tool: "do", args: ($args | skip 1) }
  } else if $args.0 == "mut" {
    { tool: "gt", args: (["modify"] | append ($args | skip 1)) }
  } else if $args.0 == "check" {
    { tool: "check", args: ($args | skip 1) }
  } else if $args.0 == "unfuck" {
    { tool: "unfuck", args: ($args | skip 1) }
  } else if $args.0 == "take" {
    { tool: "take", args: ($args | skip 1) }
  } else if $args.0 == "issue" {
    { tool: "issue", args: ($args | skip 1) }
  } else if $args.0 == "pr" {
    { tool: "pr", args: ($args | skip 1) }
  } else if $args.0 == "md" {
    { tool: "md", args: ($args | skip 1) }
  } else if $args.0 == "infra" {
    { tool: "infra", args: ($args | skip 1) }
  } else if $args.0 == "genie" {
    { tool: "genie", args: ($args | skip 1) }
  } else if $args.0 in $gt_commands {
    { tool: "gt", args: $args }
  } else if $args.0 in $git_commands {
    {
      tool: "git",
      args: $args
    }
  } else if $args.0 == "help" or $args.0 == "--help" or $args.0 == "-h" {
    {
      tool: "help",
      args: ($args | skip 1)
    }
  } else {
    { tool: "unknown", args: $args }
  }
}
