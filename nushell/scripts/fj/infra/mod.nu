# `fj infra` is a thin alias layer over the packaged infra apps in
# `infra/default.nix` (`nix run .#tfPlan` / `.#tfApply` / `.#tfVars`). Those own
# the real logic — auto-init, fresh-checkout seeding from the example, decrypt /
# re-encrypt around each action, identity resolution — so this module just maps
# the `fj infra` verbs onto them instead of maintaining a second, divergent copy.

# mod.nu imports dispatch directly — not via `fj infra`, which parses as main at compile time.
export def dispatch [args: list<string>] {
  main ...$args
}

export def main [...args: string] {
  if ($args | is-empty) {
    consequences
  } else if $args.0 == "consequences" {
    consequences
  } else if $args.0 == "enact" {
    enact
  } else if $args.0 == "edit" and ($args | get 1?) == "vars" {
    edit vars
  } else {
    error make --unspanned { msg: $"unknown fj infra subcommand: ($args | str join ' ')" }
  }
}

def infra-app [app: string] {
  ^nix run $"($env.HOME)/.config#($app)"
}

export def consequences [] {
  infra-app "tfPlan"
}

export def enact [] {
  infra-app "tfApply"
}

export def "edit vars" [] {
  infra-app "tfVars"
}
