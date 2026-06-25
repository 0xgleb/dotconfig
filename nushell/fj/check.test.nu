use std/assert

source check.nu

# --- skill-issue ---

def "test skill-issue returns a string from the list" [] {
  let msg = (skill-issue)
  assert ($msg | is-not-empty) "skill-issue should return a non-empty string"
  assert (($msg | str length) > 10) "skill-issue message should be reasonably long"
}

# --- test runner ---

def main [] {
  print "Running check tests..."
  let tests = (scope commands
    | where ($it.type == "custom") and ($it.name | str starts-with "test ")
    | get name)

  let test_commands = ($tests
    | each {|test_name| $"($test_name); print '  ok ($test_name)'" }
    | str join "; ")

  nu --commands $"source ($env.CURRENT_FILE); ($test_commands)"
  print $"(ansi green)All ($tests | length) tests passed(ansi reset)"
}
