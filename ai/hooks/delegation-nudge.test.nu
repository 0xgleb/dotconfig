use std/assert

# The hook is a standalone script invoked via `nu <path>` with its JSON event
# payload on stdin (see claude.settings.json's hooks block), not a module
# function - so these tests exercise it the same way production does: spawn
# it as a real subprocess and feed it the same payload shape Claude Code
# sends, rather than reimplementing its counting logic in-test.
const hook_script = ($env.CURRENT_FILE | path dirname | path join "delegation-nudge.nu")

def run-hook [session: string, tool: string]: nothing -> record {
  let payload = ({ session_id: $session, tool_name: $tool } | to json -r)
  let result = ($payload | ^nu $hook_script | complete)
  { exit_code: $result.exit_code, stdout: ($result.stdout | str trim) }
}

def state-file [session: string]: nothing -> string {
  let sanitized = ($session | str replace --all --regex '[^a-zA-Z0-9-]' '')
  $"/tmp/claude-delegation-streak-($sanitized)"
}

def forget [session: string] {
  rm --force (state-file $session)
}

def "test the streak stays silent below the nudge threshold" [] {
  let session = $"test-below-(random uuid)"
  forget $session
  let first = (run-hook $session "Edit")
  let second = (run-hook $session "Edit")
  assert equal $first.exit_code 0
  assert equal $first.stdout ""
  assert equal $second.stdout ""
  forget $session
}

def "test the streak nudges on the third consecutive edit and every third after that, not every edit" [] {
  let session = $"test-onward-(random uuid)"
  forget $session
  run-hook $session "Edit" | ignore
  run-hook $session "Edit" | ignore
  let third = (run-hook $session "Edit")
  let fourth = (run-hook $session "Edit")
  let fifth = (run-hook $session "Edit")
  let sixth = (run-hook $session "Edit")
  assert ($third.stdout | str contains "Delegation check")
  assert ($third.stdout | str contains "#3")
  assert equal $fourth.stdout ""
  assert equal $fifth.stdout ""
  assert ($sixth.stdout | str contains "Delegation check")
  assert ($sixth.stdout | str contains "#6")
  forget $session
}

def "test a non-edit tool call resets the streak" [] {
  let session = $"test-reset-(random uuid)"
  forget $session
  run-hook $session "Edit" | ignore
  run-hook $session "Edit" | ignore
  run-hook $session "Edit" | ignore
  run-hook $session "Bash" | ignore
  let after_reset = (run-hook $session "Edit")
  assert equal $after_reset.stdout ""
  forget $session
}

def "test the nudge output matches the documented PostToolUse hookSpecificOutput shape" [] {
  let session = $"test-shape-(random uuid)"
  forget $session
  run-hook $session "Edit" | ignore
  run-hook $session "Edit" | ignore
  let nudged = (run-hook $session "Edit")
  let parsed = ($nudged.stdout | from json)
  assert equal $parsed.hookSpecificOutput.hookEventName "PostToolUse"
  assert (($parsed.hookSpecificOutput.additionalContext | str contains "Delegation check"))
  forget $session
}

def "test a malicious session id is sanitized before it ever touches a filesystem path" [] {
  let malicious = "abc; rm -rf /tmp/should-not-run"
  let result = (run-hook $malicious "Edit")
  assert equal $result.exit_code 0
  forget $malicious
}

# --- test runner ---

def main [] {
  print "Running delegation-nudge hook tests..."
  let tests = (scope commands
    | where ($it.type == "custom") and ($it.name | str starts-with "test ")
    | get name)

  let test_commands = ($tests
    | each {|test_name| $"($test_name); print '  ok ($test_name)'" }
    | str join "; ")

  nu --commands $"source ($env.CURRENT_FILE); ($test_commands)"
  print $"(ansi green)All ($tests | length) tests passed(ansi reset)"
}
