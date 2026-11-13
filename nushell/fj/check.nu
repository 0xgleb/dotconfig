use log.nu

const CHECK_SOURCE = path self

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

def dotconfig-check [] {
  log info "dotconfig checks"

  let repo_root = (^git rev-parse --show-toplevel)

  log debug "checking nix formatting"
  ^nixfmt --check ...(glob $"($repo_root)/**/*.nix")

  log debug "running nix flake check"
  ^nix flake check $repo_root

  log info "dotconfig passed the vibe check"
}

def detect-repo []: nothing -> string {
  let url = (^git remote get-url origin)
  if ($url | str contains "dotconfig") {
    "dotconfig"
  } else {
    "unknown"
  }
}

# Detect the current repo and run its checks; errors if it isn't recognized.
def dispatch-check [] {
  match (detect-repo) {
    "dotconfig" => { dotconfig-check }
    _ => { error make { msg: $"Couldn't determine what checks to run in (pwd)" } }
  }
}

export def run-captured []: nothing -> record<passed: bool, output: string> {
  let command = $"source ($CHECK_SOURCE | to nuon)\ndispatch-check"
  let result = (
    ^$nu.current-exe --no-config-file --no-history --commands $command
      | tee { print --raw }
      | tee --stderr { print --raw --stderr }
      | complete
  )
  if $result.exit_code == 130 {
    error make --unspanned {msg: "interrupted"}
  }
  {passed: ($result.exit_code == 0), output: ($result.stdout + $result.stderr)}
}

export def skill-issue []: nothing -> string {
  $skill_issues | shuffle | first
}

export def execute [] {
  let result = (run-captured)
  if not $result.passed {
    print $"\n(ansi red_bold)(skill-issue)(ansi reset)\n"
    error make --unspanned {msg: "repository checks failed"}
  }
}
