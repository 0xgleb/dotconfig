# Standalone CLI entrypoint for mdup (used by nix build).
# Expects md-sync-lib.nu and md-lib.nu to be in the same directory.

source md-sync-lib.nu
source md-lib.nu

def "main plan" [
  --org: string
  --vault: string
  --config: string
  --out: string
] {
  run-plan --org $org --vault $vault --config $config --out $out
}

def "main apply" [
  --plan: string
  --yes (-y)
] {
  run-apply --plan $plan --yes=$yes
}

def "main diff" [
  --plan: string
  --org: string
  --vault: string
  --config: string
  --stat
] {
  run-diff --plan $plan --org $org --vault $vault --config $config --stat=$stat
}

def main [] {
  run-plan
  run-diff
  run-apply
}
