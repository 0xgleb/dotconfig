# jf — standalone entrypoint for the fj module
# Used by the nix package. @fjLib@ is replaced at build time.

const NU_LIB_DIRS = ["@fjLib@"]

use fj/

def --wrapped main [...args: string] {
  fj ...$args
}

# nushell cannot dynamically dispatch to module subcommands through
# --wrapped main, so md/* and infra/* need explicit forwarding

def "main md" [] {
  fj md
}

def "main md plan" [
  --org: string
  --vault: string
  --config: string
  --out: string
  --verbose (-v)
] {
  fj md plan --org $org --vault $vault --config $config --out $out --verbose=$verbose
}

def "main md diff" [
  --plan: string
  --org: string
  --vault: string
  --config: string
  --stat
] {
  fj md diff --plan $plan --org $org --vault $vault --config $config --stat=$stat
}

def "main md sync" [
  --plan: string
  --yes (-y)
] {
  fj md sync --plan $plan --yes=$yes
}

def "main infra" [] {
  fj infra
}

def "main infra consequences" [] {
  fj infra consequences
}

def "main infra enact" [] {
  fj infra enact
}

def "main infra edit vars" [] {
  fj infra edit vars
}
