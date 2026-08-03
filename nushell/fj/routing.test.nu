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

# --- session directory encodings ---

def "test claude-project-dirname encodes dots and slashes" [] {
  let encoded = (claude-project-dirname "/Users/0xgleb/.config")
  assert equal $encoded "-Users-0xgleb--config"
}

def "test claude-project-dirname encodes underscores" [] {
  let encoded = (claude-project-dirname "/a/b_c/d.e")
  assert equal $encoded "-a-b-c-d-e"
}

def "test pi-project-dirname matches pi session storage" [] {
  assert equal (pi-project-dirname "/Users/0xgleb/.config") "--Users-0xgleb-.config--"
}

# --- clanker-route: Pi by default, Claude by opt-in ---

def "test clanker defaults to pi and resumes" [] {
  let route = (clanker-route true true)
  assert equal $route.tool "pi"
  assert (("--continue" in $route.args)) "should resume the Pi session"
  assert (("high" in $route.args)) "should use high thinking"
}

def "test clanker starts fresh when pi has no session" [] {
  let route = (clanker-route false true "fix the bug")
  assert equal $route.tool "pi"
  assert (not ("--continue" in $route.args))
  assert (("fix the bug" in $route.args))
}

def "test clanker new starts a fresh pi session" [] {
  let route = (clanker-route true true --new "fix the bug")
  assert (not ("--continue" in $route.args))
  assert (not ("--new" in $route.args)) "--new is consumed"
  assert (("fix the bug" in $route.args))
}

def "test clanker does not double an explicit pi continue flag" [] {
  let count = (clanker-route true true --continue | get args | where { $in == "--continue" } | length)
  assert equal $count 1
}

def "test clanker honours explicit pi session flags" [] {
  let route = (clanker-route true true --session abc123)
  assert (not ("--continue" in $route.args))
  assert (("abc123" in $route.args))
}

def "test clanker dispatcher runs pi on the local model with the loop prompt" [] {
  let route = (clanker-route false false --dispatcher)
  assert equal $route.tool "pi-dispatcher"
  assert (("ollama/qwen3:4b" in $route.args))
  assert (("/loop 10m /dispatcher" in $route.args))
  assert (not ("--dispatcher" in $route.args)) "--dispatcher is consumed"
}

def "test clanker dispatcher resumes without re-sending the loop prompt" [] {
  let route = (clanker-route true false --dispatcher)
  assert equal $route.tool "pi-dispatcher"
  assert (("--continue" in $route.args))
  assert (not ("/loop 10m /dispatcher" in $route.args))
}

def "test clanker dispatcher forwards an explicit prompt instead of the default" [] {
  let route = (clanker-route false false --dispatcher "check the bridge inbox")
  assert (("check the bridge inbox" in $route.args))
  assert (not ("/loop 10m /dispatcher" in $route.args))
}

def "test clanker dispatcher forwards an explicit model override after the default" [] {
  let route = (clanker-route false false --dispatcher --model "ollama/other-local")
  let indexed = ($route.args | enumerate)
  let default_index = ($indexed | where item == "ollama/qwen3:4b" | first | get index)
  let override_index = ($indexed | where item == "ollama/other-local" | first | get index)
  assert ($override_index > $default_index) "explicit --model must come after the default so pi's last-wins parsing applies it"
}

def "test clanker claude preserves auto workflows" [] {
  let route = (clanker-route true true --claude)
  assert equal $route.tool "claude"
  assert (("--continue" in $route.args))
  assert (("auto" in $route.args))
  let settings = ($route.args | skip until { $in == "--settings" } | get 1 | from json)
  assert equal $settings.effortLevel "high"
  assert equal $settings.enableWorkflows true
}

def "test clanker claude consumes selector and supports remote control" [] {
  let route = (clanker-route true true --claude --remote-control "fix the bug")
  assert equal $route.tool "claude"
  assert (not ("--claude" in $route.args))
  assert (("--remote-control" in $route.args))
  assert (("fix the bug" in $route.args))
}

def "test clanker never adds claude remote control to pi" [] {
  let route = (clanker-route true true --remote-control)
  assert equal $route.tool "pi"
  assert (not ("--remote-control" in $route.args))
}

# The `clanker` wrapper in mod.nu is --wrapped: user flags land in $args as
# strings and are spread into clanker-route at runtime. Spread values are never
# re-parsed as flags, so selectors must be consumed from the rest args.

def "test clanker claude selector routes when spread as runtime args" [] {
  let args = ["--claude" "fix the bug"]
  let route = (clanker-route true true ...$args)
  assert equal $route.tool "claude"
  assert (not ("--claude" in $route.args)) "--claude is consumed"
  assert (("fix the bug" in $route.args))
}

def "test clanker new selector starts fresh when spread as runtime args" [] {
  let args = ["--new" "fix the bug"]
  let route = (clanker-route true true ...$args)
  assert equal $route.tool "pi"
  assert (not ("--continue" in $route.args)) "--new suppresses resume"
  assert (not ("--new" in $route.args)) "--new is consumed"
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
  assert equal (fj-route ...[create my-branch -m msg]) {
    tool: "gt", args: ["create", "my-branch", "-m", "msg"]
  }
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
  assert equal (fj-route ...[untrack 03-14-nvim_life]) {
    tool: "gt", args: ["untrack", "03-14-nvim_life"]
  }
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
  assert equal (fj-route ...[blame src/main.rs]) {
    tool: "git", args: ["blame", "src/main.rs"]
  }
}

# --- internal passthrough commands ---
# check/clanker/take/issue/pr/md/infra are dedicated subcommands that shadow
# main, so fj-route never sees them (see routing.nu); only do/help reach here.

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

def "test vcs-backend st0x repo is graphite even when not gitbutler-managed" [] {
  assert equal (vcs-backend "/home/u/code/st0x/st0x.liquidity" "/home/u" false) "gt"
}

def "test vcs-backend nested subdir of graphite org is graphite" [] {
  assert equal (vcs-backend "/home/u/code/st0x/st0x.liquidity/dashboard/src" "/home/u" false) "gt"
}

def "test vcs-backend other repo managed by gitbutler is but" [] {
  assert equal (vcs-backend "/home/u/code/data-cartel/example" "/home/u" true) "but"
}

def "test vcs-backend other repo not gitbutler-managed is git" [] {
  assert equal (vcs-backend "/home/u/code/data-cartel/example" "/home/u" false) "git"
}

def "test vcs-backend dotconfig not gitbutler-managed is git" [] {
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
  assert equal (resolve-stack { tool: "do", args: [] } "but") { tool: "do", args: [] }
}

# gitbutler verb translation

def "test resolve-stack but translates modify to amend keeping flags" [] {
  assert equal (resolve-stack { tool: "gt", args: ["modify", "-a"] } "but") {
    tool: "but", args: ["amend", "-a"]
  }
}

def "test resolve-stack but translates ss to push all" [] {
  assert equal (resolve-stack { tool: "gt", args: ["ss"] } "but") {
    tool: "but", args: ["push", "all"]
  }
}

def "test resolve-stack but translates sync to pull" [] {
  assert equal (resolve-stack { tool: "gt", args: ["sync"] } "but") { tool: "but", args: ["pull"] }
}

def "test resolve-stack but translates co to apply with branch arg" [] {
  assert equal (resolve-stack { tool: "gt", args: ["co", "feature"] } "but") {
    tool: "but", args: ["apply", "feature"]
  }
}

def "test resolve-stack but translates create to branch new" [] {
  assert equal (resolve-stack { tool: "gt", args: ["create", "my-branch"] } "but") {
    tool: "but", args: ["branch", "new", "my-branch"]
  }
}

def "test resolve-stack but translates untrack to unapply" [] {
  assert equal (resolve-stack { tool: "gt", args: ["untrack", "br"] } "but") {
    tool: "but", args: ["unapply", "br"]
  }
}

def "test resolve-stack but reports cursor-move verb as unsupported" [] {
  assert equal (resolve-stack { tool: "gt", args: ["up"] } "but") {
    tool: "unsupported", args: ["up", "but"]
  }
}

# plain-git fallback translation

def "test resolve-stack git translates modify to commit amend" [] {
  assert equal (resolve-stack { tool: "gt", args: ["modify"] } "git") {
    tool: "git", args: ["commit", "--amend"]
  }
}

def "test resolve-stack git translates create to checkout dash b" [] {
  assert equal (resolve-stack { tool: "gt", args: ["create", "br"] } "git") {
    tool: "git", args: ["checkout", "-b", "br"]
  }
}

def "test resolve-stack git reports squash as unsupported" [] {
  assert equal (resolve-stack { tool: "gt", args: ["squash"] } "git") {
    tool: "unsupported", args: ["squash", "git"]
  }
}

def "test resolve-stack git translates ss to force-with-lease push" [] {
  assert equal (resolve-stack { tool: "gt", args: ["ss"] } "git") {
    tool: "git", args: ["push", "--force-with-lease"]
  }
}

def "test resolve-stack git translates submit to push" [] {
  assert equal (resolve-stack { tool: "gt", args: ["submit"] } "git") {
    tool: "git", args: ["push"]
  }
}

def "test resolve-stack git translates sync to pull" [] {
  assert equal (resolve-stack { tool: "gt", args: ["sync"] } "git") {
    tool: "git", args: ["pull"]
  }
}

def "test resolve-stack git translates co preserving branch arg" [] {
  assert equal (resolve-stack { tool: "gt", args: ["co", "feature"] } "git") {
    tool: "git", args: ["checkout", "feature"]
  }
}

def "test resolve-stack git translates checkout preserving branch arg" [] {
  assert equal (resolve-stack { tool: "gt", args: ["checkout", "feature"] } "git") {
    tool: "git", args: ["checkout", "feature"]
  }
}

def "test resolve-stack git translates rename preserving branch name" [] {
  assert equal (resolve-stack { tool: "gt", args: ["rename", "new-name"] } "git") {
    tool: "git", args: ["branch", "-m", "new-name"]
  }
}

# --- protected-branch force-push guard ---

def "test protected-push-blocked blocks ss on master git backend" [] {
  assert (protected-push-blocked { tool: "gt", args: ["ss"] } "git" "master")
}

def "test protected-push-blocked blocks ss on main but backend" [] {
  assert (protected-push-blocked { tool: "gt", args: ["ss"] } "but" "main")
}

def "test protected-push-blocked allows ss on a feature branch" [] {
  assert (not (protected-push-blocked { tool: "gt", args: ["ss"] } "git" "feat/x"))
}

def "test protected-push-blocked leaves the graphite backend alone" [] {
  assert (not (protected-push-blocked { tool: "gt", args: ["ss"] } "gt" "master"))
}

def "test protected-push-blocked ignores non-ss verbs on master" [] {
  assert (not (protected-push-blocked { tool: "gt", args: ["sync"] } "git" "master"))
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
