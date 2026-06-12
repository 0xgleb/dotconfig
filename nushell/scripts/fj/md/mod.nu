use lib.nu [run-plan run-diff run-apply]

def has-flag [args: list<string>, ...flags: string] {
  $flags | any {|flag| $flag in $args }
}

def flag-value [args: list<string>, flag: string] {
  let hit = ($args | enumerate | where item == $flag | first)
  if $hit == null { null } else { $args | get ($hit.index + 1) }
}

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

# mod.nu imports dispatch directly — not via `fj md`, which parses as main at compile time.
export def dispatch [args: list<string>] {
  main ...$args
}

export def main [...args: string] {
  if ($args | is-empty) {
    with-quiet-logs {
      run-plan
      run-diff
      run-apply
    }
  } else if $args.0 == "plan" {
    let rest = ($args | skip 1)
    plan --verbose=(has-flag $rest "-v" "--verbose") --org=(flag-value $rest "--org") --vault=(flag-value $rest "--vault") --config=(flag-value $rest "--config") --out=(flag-value $rest "--out")
  } else if $args.0 == "diff" {
    let rest = ($args | skip 1)
    diff --plan=(flag-value $rest "--plan") --org=(flag-value $rest "--org") --vault=(flag-value $rest "--vault") --config=(flag-value $rest "--config") --stat=(has-flag $rest "--stat")
  } else if $args.0 == "sync" {
    let rest = ($args | skip 1)
    sync --plan=(flag-value $rest "--plan") --yes=(has-flag $rest "-y" "--yes")
  } else {
    error make --unspanned { msg: $"unknown fj md subcommand: ($args.0)" }
  }
}
