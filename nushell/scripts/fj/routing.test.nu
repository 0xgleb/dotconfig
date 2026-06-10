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

def "test fj squash routes to gt" [] {
  assert equal (fj-route squash) { tool: "gt", args: ["squash"] }
}

def "test fj untrack routes to gt" [] {
  assert equal (fj-route ...[untrack 03-14-nvim_life]) { tool: "gt", args: ["untrack", "03-14-nvim_life"] }
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

# --- internal commands ---

def "test fj check routes to check" [] {
  assert equal (fj-route check) { tool: "check", args: [] }
}

def "test fj unfuck routes to unfuck" [] {
  assert equal (fj-route unfuck) { tool: "unfuck", args: [] }
}

def "test fj take routes to take" [] {
  assert equal (fj-route ...[take ours src/lib.rs]) { tool: "take", args: ["ours", "src/lib.rs"] }
}

def "test fj issue routes to issue" [] {
  assert equal (fj-route issue) { tool: "issue", args: [] }
}

def "test fj issue list routes to issue with list" [] {
  assert equal (fj-route ...[issue list --label bug]) { tool: "issue", args: ["list", "--label", "bug"] }
}

def "test fj pr routes to pr" [] {
  assert equal (fj-route pr) { tool: "pr", args: [] }
}

def "test fj pr view routes to pr with view" [] {
  assert equal (fj-route ...[pr view 42]) { tool: "pr", args: ["view", "42"] }
}

def "test fj md routes to md" [] {
  assert equal (fj-route ...[md plan --verbose]) { tool: "md", args: ["plan", "--verbose"] }
}

def "test fj infra routes to infra" [] {
  assert equal (fj-route ...[infra consequences]) { tool: "infra", args: ["consequences"] }
}

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

# --- vcs backend detection ---

def "test vcs-backend rainlanguage repo is graphite" [] {
  assert equal (vcs-backend "/home/u/code/rainlanguage/rain.cli" "/home/u" true) "gt"
}

def "test vcs-backend st0x repo is graphite even without gitbutler" [] {
  assert equal (vcs-backend "/home/u/code/st0x/st0x.liquidity" "/home/u" false) "gt"
}

def "test vcs-backend nested subdir of graphite org is graphite" [] {
  assert equal (vcs-backend "/home/u/code/st0x/st0x.liquidity/dashboard/src" "/home/u" false) "gt"
}

def "test vcs-backend other repo with gitbutler is but" [] {
  assert equal (vcs-backend "/home/u/code/data-cartel/moneymentum" "/home/u" true) "but"
}

def "test vcs-backend other repo without gitbutler is git" [] {
  assert equal (vcs-backend "/home/u/code/data-cartel/moneymentum" "/home/u" false) "git"
}

def "test vcs-backend dotconfig without gitbutler is git" [] {
  assert equal (vcs-backend "/home/u/.config" "/home/u" false) "git"
}

def "test vcs-backend org name outside code dir does not match" [] {
  assert equal (vcs-backend "/home/u/work/rainlanguage/x" "/home/u" false) "git"
}

# --- resolve-stack: backend + verb translation ---

def "test resolve-stack keeps graphite route unchanged" [] {
  assert equal (resolve-stack { tool: "gt", args: ["ss"] } "gt") { tool: "gt", args: ["ss"] }
}

def "test resolve-stack passes through non-stack git route" [] {
  assert equal (resolve-stack { tool: "git", args: ["push"] } "but") { tool: "git", args: ["push"] }
}

def "test resolve-stack passes through internal route" [] {
  assert equal (resolve-stack { tool: "issue", args: [] } "but") { tool: "issue", args: [] }
}

# gitbutler verb translation

def "test resolve-stack but translates modify to amend keeping flags" [] {
  assert equal (resolve-stack { tool: "gt", args: ["modify", "-a"] } "but") { tool: "but", args: ["amend", "-a"] }
}

def "test resolve-stack but translates ss to push all" [] {
  assert equal (resolve-stack { tool: "gt", args: ["ss"] } "but") { tool: "but", args: ["push", "all"] }
}

def "test resolve-stack but translates sync to pull" [] {
  assert equal (resolve-stack { tool: "gt", args: ["sync"] } "but") { tool: "but", args: ["pull"] }
}

def "test resolve-stack but translates co to apply with branch arg" [] {
  assert equal (resolve-stack { tool: "gt", args: ["co", "feature"] } "but") { tool: "but", args: ["apply", "feature"] }
}

def "test resolve-stack but translates create to branch new" [] {
  assert equal (resolve-stack { tool: "gt", args: ["create", "my-branch"] } "but") { tool: "but", args: ["branch", "new", "my-branch"] }
}

def "test resolve-stack but translates untrack to unapply" [] {
  assert equal (resolve-stack { tool: "gt", args: ["untrack", "br"] } "but") { tool: "but", args: ["unapply", "br"] }
}

def "test resolve-stack but reports cursor-move verb as unsupported" [] {
  assert equal (resolve-stack { tool: "gt", args: ["up"] } "but") { tool: "unsupported", args: ["up", "but"] }
}

# plain-git fallback translation

def "test resolve-stack git translates modify to commit amend" [] {
  assert equal (resolve-stack { tool: "gt", args: ["modify"] } "git") { tool: "git", args: ["commit", "--amend"] }
}

def "test resolve-stack git translates create to checkout dash b" [] {
  assert equal (resolve-stack { tool: "gt", args: ["create", "br"] } "git") { tool: "git", args: ["checkout", "-b", "br"] }
}

def "test resolve-stack git reports squash as unsupported" [] {
  assert equal (resolve-stack { tool: "gt", args: ["squash"] } "git") { tool: "unsupported", args: ["squash", "git"] }
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
