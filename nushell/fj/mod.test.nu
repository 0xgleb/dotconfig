use std/assert

def expected-commands [] {
  [
    "fj" "fj check" "fj cheatsheet" "fj issue" "fj issue list" "fj issue view"
    "fj pr" "fj pr list" "fj pr view" "fj md" "fj md plan" "fj md diff" "fj md sync"
    "fj infra" "fj infra consequences" "fj infra enact" "fj infra edit vars"
    "fj infra provision" "fj infra decommission"
  ]
}

def "test fj module exports all subcommands" [] {
  let fj_commands = (scope commands
    | where name =~ '^fj'
    | get name)

  for expected in (expected-commands) {
    assert ($fj_commands | any {|cmd| $cmd == $expected }) $"missing command: ($expected)"
  }
}

# --- unknown commands must error, not fall through ---

def "test fj help does not error" [] {
  try { fj help } catch {|e|
    assert (not ($e.msg | str contains "unknown fj command")) "fj help should not error as unknown"
  }
}

def "test fj rejects yolo" [] {
  try {
    fj yolo
    assert false "fj yolo should have errored"
  } catch {|e|
    assert ($e.msg | str contains "unknown fj command")
  }
}

def "test fj rejects foo" [] {
  try {
    fj foo
    assert false "fj foo should have errored"
  } catch {|e|
    assert ($e.msg | str contains "unknown fj command")
  }
}

# --- whitelisted git commands must route (not error as unknown) ---

def "test fj diff does not error as unknown" [] {
  try { fj diff --stat } catch {|e|
    assert (not ($e.msg | str contains "unknown fj command")) (
      "fj diff should route to git, not error as unknown"
    )
  }
}

# --- stack commands must route (not error as unknown) ---

def "test fj ls does not error as unknown" [] {
  try { fj ls } catch {|e|
    assert (not ($e.msg | str contains "unknown fj command")) (
      "fj ls should route to the selected stack backend, not error as unknown"
    )
  }
}

def "test fj untrack does not error as unknown" [] {
  try { fj untrack test-branch } catch {|e|
    assert (not ($e.msg | str contains "unknown fj command")) (
      "fj untrack should route to the selected stack backend, not error as unknown"
    )
  }
}

def "test clanker never continues an already-live Pi session" [] {
  let fj_dir = ($env.CURRENT_FILE | path dirname)
  let source = (open ($fj_dir | path join "mod.nu"))
  let routing = (open ($fj_dir | path join "routing.nu"))
  let package = (open ($fj_dir | path dirname | path join "jf.nix"))
  assert ($source | str contains "active-pi-session-ids")
  assert ($source | str contains "expires_at >")
  assert ($source | str contains "SELECT agent_id, pid")
  assert ($source | str contains "process-is-alive")
  assert ($source | str contains "^kill -0")
  assert ($source | str contains "live-safe-pi-resume-route")
  assert ($routing | str contains "the most recent Pi session is already live")
  assert ($package | str contains "    sqlite") "managed jf must provide sqlite3 for active-session admission"
}

def "test crashed Pi PID is not treated as a live session" [] {
  assert (fj process-is-alive $nu.pid) "the current Nu process must be live"
  assert (not (fj process-is-alive 2_147_483_647)) "an impossible PID must be inactive"
}

def "test local dispatcher unloads idle model weights" [] {
  let source = (open ($env.CURRENT_FILE | path dirname | path join "mod.nu"))
  assert ($source | str contains "OLLAMA_KEEP_ALIVE=5m")
  assert (not ($source | str contains "OLLAMA_KEEP_ALIVE=-1"))
}

def "test local dispatcher owns the ollama process lifecycle" [] {
  let source = (open ($env.CURRENT_FILE | path dirname | path join "mod.nu"))
  assert ($source | str contains "run-local-dispatcher")
  assert ($source | str contains "trap cleanup EXIT INT TERM HUP")
  assert ($source | str contains "ollama stop qwen3.5:9b")
  assert ($source | str contains 'kill "$server_pid"')
  assert (not ($source | str contains "nohup env OLLAMA_CONTEXT_LENGTH"))
}

# --- test runner ---

def main [] {
  print "Running fj module tests..."
  let tests = (scope commands
    | where ($it.type == "custom") and ($it.name | str starts-with "test ")
    | get name)

  let test_commands = ($tests
    | each {|test_name| $"($test_name); print '  ok ($test_name)'" }
    | str join "; ")

  let fj_dir = ($env.CURRENT_FILE | path dirname)
  nu --commands $"use ($fj_dir); source ($env.CURRENT_FILE); ($test_commands)"
  print $"(ansi green)All ($tests | length) tests passed(ansi reset)"
}
