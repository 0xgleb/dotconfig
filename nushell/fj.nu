# fj routing logic — returns { tool: string, args: list<string> }
# Extracted for testability; fj in config.nu calls this then executes.

const gt_commands = [create modify ss submit sync co checkout up down restack reorder move absorb ls ll log init get guide demo feedback]

def --wrapped fj-route [...args: string]: nothing -> record<tool: string, args: list<string>> {
  if ($args | length) == 0 {
    { tool: "status", args: [] }
  } else if $args.0 == "ui" {
    { tool: "gitui", args: ($args | skip 1) }
  } else if $args.0 == "pr" {
    { tool: "gh", args: (["pr"] | append ($args | skip 1)) }
  } else if $args.0 == "mut" {
    { tool: "gt", args: (["modify"] | append ($args | skip 1)) }
  } else if $args.0 in $gt_commands {
    { tool: "gt", args: $args }
  } else {
    { tool: "git", args: $args }
  }
}
