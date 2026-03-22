use std/assert

source unicode-check.nu

# --- has-non-ascii ---

def "test has-non-ascii false for plain ascii" [] {
  assert equal (has-non-ascii "hello world") false
}

def "test has-non-ascii false for empty string" [] {
  assert equal (has-non-ascii "") false
}

def "test has-non-ascii true for em dash" [] {
  assert equal (has-non-ascii "hello -- world") false
  assert equal (has-non-ascii "hello \u{2014} world") true
}

def "test has-non-ascii true for right arrow" [] {
  assert equal (has-non-ascii "a -> b") false
  assert equal (has-non-ascii "a \u{2192} b") true
}

def "test has-non-ascii false for common code characters" [] {
  assert equal (has-non-ascii "fn main() { let x = 42; }") false
  assert equal (has-non-ascii "#!/usr/bin/env nu\n# comment") false
  assert equal (has-non-ascii "\"quotes\" and 'apostrophes' and `backticks`") false
}

# --- extract-content ---

def "test extract-content gets Write content" [] {
  let data = { tool_name: "Write", tool_input: { file_path: "/tmp/f", content: "hello" } }
  assert equal (extract-content $data) "hello"
}

def "test extract-content gets Edit new_string" [] {
  let data = { tool_name: "Edit", tool_input: { file_path: "/tmp/f", old_string: "old", new_string: "new" } }
  assert equal (extract-content $data) "new"
}

def "test extract-content returns empty for other tools" [] {
  let data = { tool_name: "Read", tool_input: { file_path: "/tmp/f" } }
  assert equal (extract-content $data) ""
}

def "test extract-content returns empty for missing fields" [] {
  let data = { tool_name: "Write", tool_input: {} }
  assert equal (extract-content $data) ""
}

# --- check-unicode ---

def "test check-unicode allows ascii Write" [] {
  let data = { tool_name: "Write", tool_input: { content: "plain ascii" } }
  assert equal (check-unicode $data) {}
}

def "test check-unicode denies unicode Write" [] {
  let data = { tool_name: "Write", tool_input: { content: "has \u{2014} em dash" } }
  let result = (check-unicode $data)
  assert equal $result.hookSpecificOutput.permissionDecision "deny"
}

def "test check-unicode allows ascii Edit" [] {
  let data = { tool_name: "Edit", tool_input: { new_string: "plain ascii" } }
  assert equal (check-unicode $data) {}
}

def "test check-unicode denies unicode Edit" [] {
  let data = { tool_name: "Edit", tool_input: { new_string: "arrow \u{2192} here" } }
  let result = (check-unicode $data)
  assert equal $result.hookSpecificOutput.permissionDecision "deny"
}

def "test check-unicode returns empty for non-edit tools" [] {
  let data = { tool_name: "Read", tool_input: { file_path: "/tmp/f" } }
  assert equal (check-unicode $data) {}
}

# --- test runner ---

def main [] {
  print "Running unicode-check tests..."
  let tests = (scope commands
    | where ($it.type == "custom") and ($it.name | str starts-with "test ")
    | get name)

  let test_commands = ($tests
    | each {|test_name| $"print '  ok ($test_name)'; ($test_name)" }
    | str join "; ")

  nu --commands $"source ($env.CURRENT_FILE); ($test_commands)"
  print $"(ansi green)All ($tests | length) tests passed(ansi reset)"
}
