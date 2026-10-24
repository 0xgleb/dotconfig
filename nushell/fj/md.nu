use md-lib.nu [run-plan run-diff run-apply]

def with-quiet-logs [block: closure] {
  if ($env | get -o NU_LOG_LEVEL) == null {
    $env.NU_LOG_LEVEL = "WARNING"
  }
  do $block
}

export def plan [
  --org: string      # single org root (overrides config)
  --vault: string    # vault path (overrides config)
  --config: string   # config file path (default: ~/.config/mdaemon.nuon)
  --out: string      # output plan file (default: .mdup-plan.nuon)
  --verbose (-v)     # show per-target scan progress
] {
  if $verbose { $env.NU_LOG_LEVEL = "INFO" }
  with-quiet-logs { run-plan --org $org --vault $vault --config $config --out $out }
}

export def diff [
  --plan: string     # path to existing plan file
  --org: string      # single org root (overrides config)
  --vault: string    # vault path (overrides config)
  --config: string   # config file path
  --stat             # show only per-file summary, no diffs
] {
  with-quiet-logs { run-diff --plan $plan --org $org --vault $vault --config $config --stat=$stat }
}

export def sync [
  --plan: string
  --yes (-y)
] {
  with-quiet-logs { run-apply --plan $plan --yes=$yes }
}

# `fj md plan/diff/sync` resolve to the typed subcommands above (they shadow
# this main); bare `fj md` runs the full plan -> diff -> apply. So main only
# ever sees the no-arg case and rejects anything else — no flag re-parsing.
export def --wrapped main [...args: string] {
  if ($args | is-not-empty) {
    error make --unspanned { msg: $"unknown fj md subcommand: ($args.0)" }
  }
  with-quiet-logs {
    run-plan
    run-diff
    run-apply
  }
}
