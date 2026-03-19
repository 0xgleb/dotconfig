use std/assert

use fix-worktree-submodules.nu [relative-prefix]

# --- relative-prefix: computes correct ../ depth ---

def "test shallow worktree" [] {
  assert equal (relative-prefix "/repo" "/repo/.worktrees/my-wt/lib") "../../.."
}

def "test nested worktree with slash in name" [] {
  assert equal (relative-prefix "/repo" "/repo/.worktrees/feat/auth/lib") "../../../.."
}

def "test deeply nested worktree" [] {
  assert equal (relative-prefix "/repo" "/repo/.worktrees/a/b/c/lib") "../../../../.."
}

def "test single level" [] {
  assert equal (relative-prefix "/repo" "/repo/lib") ".."
}

# --- test runner ---

def main [] {
  print "Running fix-worktree-submodules tests..."
  let tests = (scope commands
    | where ($it.type == "custom") and ($it.name | str starts-with "test ")
    | get name)

  let test_commands = ($tests
    | each {|test_name| $"print '  ok ($test_name)'; ($test_name)" }
    | str join "; ")

  nu --commands $"source ($env.CURRENT_FILE); ($test_commands)"
  print $"(ansi green)All ($tests | length) tests passed(ansi reset)"
}
