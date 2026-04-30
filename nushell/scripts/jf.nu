# jf — typo-tolerant alias for fj
# Must be loaded AFTER `use scripts/fj/`

export def --wrapped main [...args: string] { fj ...$args }

export def check [] { fj check }

export def unfuck [] { fj unfuck }

export def "do" [] { fj "do" }

export def --wrapped issue [...args: string] { fj issue ...$args }

export def --wrapped "issue list" [...args: string] { fj issue list ...$args }

export def "issue view" [
  id: string
  --web (-w)
  --comments (-c)
] {
  fj issue view $id --web=$web --comments=$comments
}

export def --wrapped pr [...args: string] { fj pr ...$args }

export def --wrapped "pr list" [...args: string] { fj pr list ...$args }

export def "pr view" [
  id?: string
  --web (-w)
  --comments (-c)
] {
  fj pr view $id --web=$web --comments=$comments
}

export def "infra consequences" [] { fj infra consequences }

export def "infra enact" [] { fj infra enact }

export def "infra edit vars" [] { fj infra edit vars }

export def md [] { fj md }

export def "md plan" [
  --org: string
  --vault: string
  --config: string
  --out: string
  --verbose (-v)
] {
  fj md plan --org $org --vault $vault --config $config --out $out --verbose=$verbose
}

export def "md diff" [
  --plan: string
  --org: string
  --vault: string
  --config: string
  --stat
] {
  fj md diff --plan $plan --org $org --vault $vault --config $config --stat=$stat
}

export def "md sync" [
  --plan: string
  --yes (-y)
] {
  fj md sync --plan $plan --yes=$yes
}
