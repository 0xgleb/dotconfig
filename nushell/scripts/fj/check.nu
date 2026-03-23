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

def logged [log_file: string] {
  $in out+err>| ^tee -a $log_file
}

def stox-liquidity-check [log_file?: string] {
  let log = ($log_file | default "/dev/null")

  let branch = (git branch --show-current)
  log info $"st0x.liquidity checks on ($branch)"

  let worktree_path = (git rev-parse --show-toplevel)
  cd $worktree_path
  log debug $"running from ($worktree_path)"

  try { rm ./dashboard/src/lib/api/* e> /dev/null }

  cargo check --color=always -q | logged $log

  log debug "auto-fixing before checks"
  try {
    (cargo fix --quiet --allow-staged
      --tests --workspace --all-features
      e> /dev/null)
  }

  (cargo nextest run --color=always
    --workspace --all-features
    --profile dev --show-progress=only
    | logged $log)

  (cargo clippy --color=always --quiet
    --workspace --all-targets --all-features
    -- -D clippy::all -D warnings
    | logged $log)

  log info "backend's looking good, checking the dashboard"

  cd $"($worktree_path)/dashboard"

  with-env { FORCE_COLOR: "1" } {
    bun install | logged $log
    bun run check | logged $log
    bun run test:run | logged $log
    bun run lint:fix | logged $log
  }
  log info "dashboard seems good to go too"

  log debug "running pre-commit hooks"
  try {
    pre-commit run -a | logged $log
  } catch {
    pre-commit run -a | logged $log
  }

  log info (
    $"st0x.liquidity on ($branch)"
    + " just passed the vibe check"
  )
}

export def run-captured [
]: nothing -> record<passed: bool, output: string> {
  let url = (git remote get-url origin)
  let is_liquidity = (
    $url | str contains "st0x.liquidity"
  )

  if not $is_liquidity {
    error make {
      msg: $"Couldn't determine what checks to run in (pwd)"
    }
  }

  let log_file = (mktemp --suffix .log)

  try {
    stox-liquidity-check $log_file
    rm -f $log_file
    { passed: true, output: "" }
  } catch {|e|
    if ($e.msg | str contains "interrupt") {
      rm -f $log_file
      error make --unspanned { msg: "interrupted" }
    }
    let captured = if ($log_file | path exists) {
      open --raw $log_file | str trim
    } else {
      ""
    }
    let error_msg = if ($e | get -o rendered? | is-not-empty) {
      $e.rendered
    } else {
      $e.msg
    }
    let output = if ($captured | is-not-empty) {
      $captured
    } else {
      $error_msg
    }
    rm -f $log_file
    { passed: false, output: $output }
  }
}

export def skill-issue []: nothing -> string {
  $skill_issues | get (random int 0..9)
}

export def run [] {
  let result = (run-captured)
  if not $result.passed {
    print $result.output
    let msg = ($skill_issues | get (random int 0..9))
    print $"\n(ansi red_bold)($msg)(ansi reset)\n"
  }
}
