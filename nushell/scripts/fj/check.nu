use std/log

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

def exe [cmd: closure] {
  log debug $"Running ($cmd)"
  do $cmd
}

def stox-liquidity-check [] {
  let branch = (git branch --show-current)
  log info $"Initiating st0x.liquidity dev checks on ($branch)"

  let worktree_path = (git rev-parse --show-toplevel)
  cd $worktree_path
  log debug $"Running from ($worktree_path)"

  log debug "Removing TS modules generates by st0x-dto"
  try { rm ./dashboard/src/lib/api/* e> /dev/null }

  exe { cargo check -q }

  log debug "Auto-fixing before checks"
  try { cargo fix --quiet --allow-staged --tests --workspace --all-features e> /dev/null }

  exe {
    cargo nextest run --workspace --all-features --profile dev --show-progress=only
  }

  exe {
    cargo clippy --quiet --workspace --all-targets --all-features -- -D clippy::all -D warnings
  }

  log info "Backend's looking good, checking the dashboard"

  log debug $"Changing directories from (pwd) to ($worktree_path)/dashboard"
  cd $"($worktree_path)/dashboard"

  exe { bun install }
  exe { bun run check }
  exe { bun run test:run }
  exe { bun run lint:fix }
  log info "The dashboard seems good to go too"

  log debug "Running pre-comit hooks"
  try { pre-commit run -a } catch { pre-commit run -a }

  log info $"Congratulations, st0x.liquidity on ($branch) just passed the vibe check"

}

export def run [] {
  $env.NU_LOG_LEVEL = "debug"
  $env.NU_LOG_FORMAT = "%ANSI_START% %DATE% :: %LEVEL% %ANSI_STOP% ==> %MSG%"

  log debug "Looking up the suite of checks for the current repo"
  let url = ( git remote get-url origin )
  let is_liquidity = ( $url | str contains "st0x.liquidity" )

  if $is_liquidity {
    try {
      stox-liquidity-check
    } catch {
      let msg = ($skill_issues | get (random int 0..9))
      print $"\n(ansi red_bold)($msg)(ansi reset)\n"
    }
  } else {
    error make { msg: $"Couldn't determine what checks to run in (pwd)"}
  }
}
