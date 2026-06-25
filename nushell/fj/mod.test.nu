use std/assert

def expected-commands [] {
  [
    "fj" "fj check" "fj cheatsheet" "fj issue" "fj issue list" "fj issue view"
    "fj pr" "fj pr list" "fj pr view" "fj md" "fj md plan" "fj md diff" "fj md sync"
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

# --- graphite commands must route (not error as unknown) ---

def "test fj ls does not error as unknown" [] {
  try { fj ls } catch {|e|
    assert (not ($e.msg | str contains "unknown fj command")) (
      "fj ls should route to gt, not error as unknown"
    )
  }
}

def "test fj untrack does not error as unknown" [] {
  try { fj untrack test-branch } catch {|e|
    assert (not ($e.msg | str contains "unknown fj command")) (
      "fj untrack should route to gt, not error as unknown"
    )
  }
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
