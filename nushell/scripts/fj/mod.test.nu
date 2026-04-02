use std/assert

def expected-commands [] {
  ["fj" "fj check" "fj issue" "fj pr" "fj md" "fj md plan" "fj md diff" "fj md sync"]
}

def "test fj module exports all subcommands" [] {
  let fj_commands = (scope commands
    | where ($it.name | str starts-with "fj")
    | get name)

  for expected in (expected-commands) {
    assert ($fj_commands | any {|cmd| $cmd == $expected }) $"missing command: ($expected)"
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

  nu --commands $"use nushell/scripts/fj/; source ($env.CURRENT_FILE); ($test_commands)"
  print $"(ansi green)All ($tests | length) tests passed(ansi reset)"
}
