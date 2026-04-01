use log.nu

const skill_issues = [
  "skill issue detected, maybe try writing code that compiles next time"
  "not gonna lie that was lowkey embarrassing, go fix your code bestie"
  "the compiler said no and honestly it has a point"
  "bro really thought that would compile, absolute delusion"
  "checks failed harder than your last relationship, try again"
  "that code is giving unhinged, the compiler is not amused"
  "sir this is a type-safe language, you can't just vibe your way through"
  "the code said 'i am not ok' and frankly neither am i after reading it"
  "certified bruh moment, checks did not pass"
  "no cap your code is cooked, respectfully go fix it"
]

def stox-liquidity-check [] {
  let branch = (git branch --show-current)
  log info $"st0x.liquidity checks on ($branch)"

  let worktree_path = (git rev-parse --show-toplevel)
  cd $worktree_path
  log debug $"running from ($worktree_path)"

  try { rm ./dashboard/src/lib/api/* e> /dev/null }

  cargo check --color=always

  log debug "auto-fixing before checks"
  try {
    (cargo fix --quiet --allow-staged
      --tests --workspace --all-features
      e> /dev/null)
  }

  (cargo nextest run --color=always
    --workspace --all-features
    --profile dev --show-progress=only)

  (cargo clippy --color=always --quiet
    --workspace --all-targets --all-features
    -- -D clippy::all -D warnings)

  log info "backend's looking good, checking the dashboard"

  cd $"($worktree_path)/dashboard"

  with-env { FORCE_COLOR: "1" } {
    bun install
    bun run check
    bun run test:run
    bun run lint:fix
  }
  log info "dashboard seems good to go too"

  log debug "running pre-commit hooks"
  try {
    pre-commit run -a
  } catch {
    pre-commit run -a
  }

  log info (
    $"st0x.liquidity on ($branch)"
    + " just passed the vibe check"
  )
}

def dotconfig-check [] {
  log info "dotconfig checks"

  let repo_root = (git rev-parse --show-toplevel)
  cd $repo_root

  log debug "checking nix formatting"
  nixfmt --check ...(glob "*.nix")

  log debug "building nix flake"
  darwin-rebuild build --flake $repo_root

  log info "dotconfig passed the vibe check"
}

def detect-repo []: nothing -> string {
  let url = (git remote get-url origin)
  if ($url | str contains "st0x.liquidity") {
    "liquidity"
  } else if ($url | str contains "dotconfig") {
    "dotconfig"
  } else {
    "unknown"
  }
}

def run-check [] {
  let repo = (detect-repo)

  if $repo == "unknown" {
    error make {
      msg: $"Couldn't determine what checks to run in (pwd)"
    }
  }

  match $repo {
    "liquidity" => { stox-liquidity-check }
    "dotconfig" => { dotconfig-check }
  }
}

export def run-captured [
]: nothing -> record<passed: bool, output: string> {
  let repo = (detect-repo)

  if $repo == "unknown" {
    error make {
      msg: $"Couldn't determine what checks to run in (pwd)"
    }
  }

  try {
    match $repo {
      "liquidity" => { stox-liquidity-check }
      "dotconfig" => { dotconfig-check }
    }
    { passed: true, output: "" }
  } catch {|e|
    if ($e.msg | str contains "interrupt") {
      error make --unspanned { msg: "interrupted" }
    }
    let error_msg = if ($e | get -o rendered? | is-not-empty) {
      $e.rendered
    } else {
      $e.msg
    }
    { passed: false, output: $error_msg }
  }
}

export def skill-issue []: nothing -> string {
  $skill_issues | get (random int 0..9)
}

export def run [] {
  try {
    run-check
  } catch {|e|
    if ($e.msg | str contains "interrupt") {
      error make --unspanned { msg: "interrupted" }
    }
    let msg = ($skill_issues | get (random int 0..9))
    print $"\n(ansi red_bold)($msg)(ansi reset)\n"
  }
}
