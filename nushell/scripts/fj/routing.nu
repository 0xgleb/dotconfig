# fj routing logic — returns { tool: string, args: list<string> }
# Extracted for testability; mod.nu calls this then executes.

const gt_commands = [create modify ss submit sync co checkout top bottom up down restack reorder move absorb rename ls ll log init get guide demo feedback]

const git_commands = [diff add status stash push pull show blame branch commit reset restore switch tag fetch rebase merge cherry-pick revert bisect remote submodule worktree clean]

export def fj-route [...args: string]: nothing -> record<tool: string, args: list<string>> {
  if ($args | length) == 0 {
    { tool: "status", args: [] }
  } else if $args.0 == "ui" {
    { tool: "gitui", args: ($args | skip 1) }
  } else if $args.0 == "mut" {
    { tool: "gt", args: (["modify"] | append ($args | skip 1)) }
  } else if $args.0 in $gt_commands {
    { tool: "gt", args: $args }
  } else if $args.0 in $git_commands {
    { tool: "git", args: $args }
  } else {
    { tool: "unknown", args: $args }
  }
}
