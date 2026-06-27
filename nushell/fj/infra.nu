# `fj infra` is a thin alias layer over the packaged infra apps in
# `infra/default.nix` (`nix run .#tfPlan` / `.#tfApply` / `.#tfVars`). Those own
# the real logic — auto-init, fresh-checkout seeding from the example, decrypt /
# re-encrypt around each action, identity resolution — so this module just maps
# the `fj infra` verbs onto them instead of maintaining a second, divergent copy.

# `fj infra consequences/enact/edit vars` resolve to the typed subcommands below
# (they shadow this main); bare `fj infra` defaults to `consequences`. So main
# only ever sees the no-arg case and rejects anything else.
export def --wrapped main [...args: string] {
  if ($args | is-not-empty) {
    error make --unspanned { msg: $"unknown fj infra subcommand: ($args | str join ' ')" }
  }
  consequences
}

def --wrapped infra-app [app: string, ...args: string] {
  let flake = $"($env.HOME)/.config#($app)"
  if ($args | is-empty) {
    ^nix run $flake
  } else {
    # `--` forwards the rest to the app, not to `nix run` itself.
    ^nix run $flake "--" ...$args
  }
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

# Stand up the box (idempotent) and attach the `nixxxos` zellij session. Extra
# args pass through, e.g. `fj infra provision s-4vcpu-8gb`.
export def --wrapped provision [...args: string] {
  infra-app "provision" ...$args
}

# Tear the box down: terraform destroy + clear the local host-key pin. Pass
# `-auto-approve` to skip terraform's confirmation.
export def --wrapped decommission [...args: string] {
  infra-app "decommission" ...$args
}
