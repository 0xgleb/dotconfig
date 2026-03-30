use std/assert

source routing.nu

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

def "test fj fold routes to gt" [] {
  assert equal (fj-route fold) { tool: "gt", args: ["fold"] }
}

def "test fj log routes to git" [] {
  assert equal (fj-route log) { tool: "git", args: ["log"] }
}

# --- whitelisted git commands ---

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

def "test fj show routes to git" [] {
  assert equal (fj-route ...[show HEAD]) { tool: "git", args: ["show", "HEAD"] }
}

def "test fj blame routes to git" [] {
  assert equal (fj-route ...[blame src/main.rs]) { tool: "git", args: ["blame", "src/main.rs"] }
}

# --- unknown commands error ---

def "test fj do routes to do" [] {
  assert equal (fj-route do) { tool: "do", args: [] }
}

def "test fj help routes to help" [] {
  assert equal (fj-route help) { tool: "help", args: [] }
}

def "test fj unknown command returns unknown" [] {
  assert equal (fj-route ...[yeet lmao]) { tool: "unknown", args: ["yeet", "lmao"] }
}

def "test fj garbage returns unknown" [] {
  assert equal (fj-route ...[yolo swag]) { tool: "unknown", args: ["yolo", "swag"] }
}

# --- test runner ---

def main [] {
  print "Running fj routing tests..."
  let tests = (scope commands
    | where ($it.type == "custom") and ($it.name | str starts-with "test ")
    | get name)

  let test_commands = ($tests
    | each {|test_name| $"($test_name); print '  ok ($test_name)'" }
    | str join "; ")

  nu --commands $"source ($env.CURRENT_FILE); ($test_commands)"
  print $"(ansi green)All ($tests | length) tests passed(ansi reset)"
}
