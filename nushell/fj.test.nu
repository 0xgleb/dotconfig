use std/assert

source fj.nu

# --- no args: status ---

def "test fj no args returns status" [] {
  assert equal (fj-route) { tool: "status", args: [] }
}

# --- ui: gitui ---

def "test fj ui routes to gitui" [] {
  assert equal (fj-route ui) { tool: "gitui", args: [] }
}

def "test fj ui passes extra args" [] {
  assert equal (fj-route ...[ui -p somerepo]) { tool: "gitui", args: ["-p", "somerepo"] }
}

# --- pr: gh ---

def "test fj pr list routes to gh" [] {
  assert equal (fj-route pr list) { tool: "gh", args: ["pr", "list"] }
}

def "test fj pr view routes to gh" [] {
  assert equal (fj-route pr view 123) { tool: "gh", args: ["pr", "view", "123"] }
}

# --- mut: gt modify ---

def "test fj mut routes to gt modify" [] {
  assert equal (fj-route mut) { tool: "gt", args: ["modify"] }
}

def "test fj mut passes flags" [] {
  assert equal (fj-route ...[mut -a]) { tool: "gt", args: ["modify", "-a"] }
}

# --- graphite commands ---

def "test fj ss routes to gt" [] {
  assert equal (fj-route ss) { tool: "gt", args: ["ss"] }
}

def "test fj create routes to gt" [] {
  assert equal (fj-route ...[create my-branch -m msg]) { tool: "gt", args: ["create", "my-branch", "-m", "msg"] }
}

def "test fj sync routes to gt" [] {
  assert equal (fj-route sync) { tool: "gt", args: ["sync"] }
}

def "test fj co routes to gt" [] {
  assert equal (fj-route co) { tool: "gt", args: ["co"] }
}

def "test fj log routes to gt" [] {
  assert equal (fj-route log) { tool: "gt", args: ["log"] }
}

# --- git fallthrough ---

def "test fj diff routes to git" [] {
  assert equal (fj-route diff) { tool: "git", args: ["diff"] }
}

def "test fj add routes to git" [] {
  assert equal (fj-route ...[add -A]) { tool: "git", args: ["add", "-A"] }
}

def "test fj status routes to git" [] {
  assert equal (fj-route status) { tool: "git", args: ["status"] }
}

def "test fj push routes to git" [] {
  assert equal (fj-route push origin main) { tool: "git", args: ["push", "origin", "main"] }
}

def "test fj stash routes to git" [] {
  assert equal (fj-route stash) { tool: "git", args: ["stash"] }
}

# --- test runner ---

def main [] {
  print "Running fj routing tests..."
  let tests = (scope commands
    | where ($it.type == "custom") and ($it.name | str starts-with "test ")
    | get name)

  let test_commands = ($tests
    | each {|test_name| $"print '  ok ($test_name)'; ($test_name)" }
    | str join "; ")

  nu --commands $"source ($env.CURRENT_FILE); ($test_commands)"
  print $"(ansi green)All ($tests | length) tests passed(ansi reset)"
}
