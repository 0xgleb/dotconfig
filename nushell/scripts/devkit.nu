use std/log

# def exe [cmd: closure] {
#   log debug $"Running ($cmd)"
#   let result = ( do $cmd | complete )
# 
#   if $result.exit_code != 0 {
#     error make {
#       msg: $"($cmd) failed:\n($result.stdout)"
#     }
#   }
# }

def exe [cmd: closure] {
  log debug $"Running ($cmd)"
  try { do $cmd } catch { |error|
    error make { msg: $"Command failed: ($error.msg)" }
  }
}

def stox-liquidity-check [] {
  let branch = (git branch --show-current)
  log info $"Initiating st0x.liquidity dev checks on ($branch)"

  let worktreePath = (git rev-parse --show-toplevel)
  cd $worktreePath
  log debug $"Running from ($worktreePath)"

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

  log debug $"Changing directories from (pwd) to ($worktreePath)/dashboard"
  cd $"($worktreePath)/dashboard"

  exe { bun install }
  exe { bun run check }
  exe { bun run test:run }
  exe { bun run lint:fix }
  log info "The dashboard seems good to go too"

  log debug "Running pre-comit hooks"
  try { pre-commit run -a } catch { pre-commit run -a }

  log info $"Congratulations, st0x.liquidity on ($branch) just passed the vibe check"

}

export def "dev check" [] {
  $env.NU_LOG_LEVEL = "debug"
  $env.NU_LOG_FORMAT = "%ANSI_START% %DATE% :: %LEVEL% %ANSI_STOP% ==> %MSG%"

  log debug "Looking up the suite of checks for the current repo"
  let url = ( git remote get-url origin )
  let isLiquidity = ( $url | str contains "st0x.liquidity" )

  if $isLiquidity {
    stox-liquidity-check
  } else {
    error make { msg: $"Couldn't determine what checks to run in (pwd)"}
  }
}
