# jf — standalone entrypoint for the fj module
# Used by the nix package. @fjLib@ is replaced at build time.

const NU_LIB_DIRS = ["@fjLib@"]

use fj/

def --wrapped main [...args: string] {
  fj ...$args
}

# The bare `main` above reaches fj's own `main`, which routes only the
# passthrough space (status, ui, do, mut, stack/git verbs, help). Nushell can't
# dispatch to a module's subcommands through a `...$args` spread, so every fj
# subcommand needs an explicit `main <name>` forwarder here.

def "main check" [] {
  fj check
}

def --wrapped "main clanker" [...args: string] {
  fj clanker ...$args
}

def "main take" [version: string, path: string] {
  fj take $version $path
}

def "main cheatsheet" [topic?: string] {
  if $topic == null { fj cheatsheet } else { fj cheatsheet $topic }
}

def --wrapped "main issue" [...args: string] {
  fj issue ...$args
}

def --wrapped "main issue list" [...args: string] {
  fj issue list ...$args
}

def "main issue view" [id: string, --web (-w), --comments (-c)] {
  fj issue view $id --web=$web --comments=$comments
}

def --wrapped "main pr" [...args: string] {
  fj pr ...$args
}

def --wrapped "main pr list" [...args: string] {
  fj pr list ...$args
}

def "main pr view" [id?: string, --web (-w), --comments (-c)] {
  if $id == null {
    fj pr view --web=$web --comments=$comments
  } else {
    fj pr view $id --web=$web --comments=$comments
  }
}

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
