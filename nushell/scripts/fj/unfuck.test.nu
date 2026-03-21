use std/assert

source unfuck.nu

def with-temp-dir [block: closure] {
  let dir = (mktemp -d)
  try {
    do $block $dir
  } catch {|e|
    rm -rf $dir
    error make { msg: $e.msg }
  }
  rm -rf $dir
}

# --- detect-issues: submodule detection ---

def "test detect-issues finds broken submodules in worktree" [] {
  with-temp-dir {|dir|
    let repo = $"($dir)/repo"
    mkdir $repo
    git -C $repo init
    "init" | save $"($repo)/README.md"
    mkdir $"($repo)/lib/fake-sub"
    "sub" | save $"($repo)/lib/fake-sub/Cargo.toml"
    git -C $repo add -A
    git -C $repo commit -m "init"

    let wt = $"($dir)/repo/.worktrees/feat/test-wt"
    git -C $repo worktree add $wt -b feat/test-wt

    # worktree has broken lib/ (gitlinks, not symlinks)
    # remove lib/ to simulate the broken state
    rm -rf $"($wt)/lib"

    cd $wt
    let issues = (detect-issues)
    assert ($issues | any {|i| $i.action == "fix-submodules" }) "should detect broken submodules"
  }
}

def "test detect-issues clean worktree with symlinks has no submodule issue" [] {
  with-temp-dir {|dir|
    let repo = $"($dir)/repo"
    mkdir $repo
    git -C $repo init
    "init" | save $"($repo)/README.md"
    mkdir $"($repo)/lib/fake-sub"
    "sub" | save $"($repo)/lib/fake-sub/Cargo.toml"
    git -C $repo add -A
    git -C $repo commit -m "init"

    let wt = $"($dir)/repo/.worktrees/feat/test-wt"
    git -C $repo worktree add $wt -b feat/test-wt

    # manually create proper symlinks (simulating already fixed state)
    rm -rf $"($wt)/lib"
    mkdir $"($wt)/lib"
    ^ln -sfn "../../../lib/fake-sub" $"($wt)/lib/fake-sub"

    cd $wt
    let issues = (detect-issues)
    assert (not ($issues | any {|i| $i.action == "fix-submodules" })) "should not flag fixed submodules"
  }
}

def "test detect-issues no issues in main repo" [] {
  with-temp-dir {|dir|
    let repo = $"($dir)/repo"
    mkdir $repo
    git -C $repo init
    "init" | save $"($repo)/README.md"
    git -C $repo add -A
    git -C $repo commit -m "init"

    cd $repo
    let issues = (detect-issues)
    assert ($issues | is-empty) "main repo should have no issues"
  }
}

# --- detect-issues: typechange detection ---

def "test detect-issues detects typechanged files" [] {
  with-temp-dir {|dir|
    let repo = $"($dir)/repo"
    mkdir $repo
    git -C $repo init

    # create a symlink, commit it, then replace with a regular file
    "target content" | save $"($dir)/target.txt"
    ^ln -s $"($dir)/target.txt" $"($repo)/LINK.md"
    git -C $repo add -A
    git -C $repo commit -m "init with symlink"

    # replace symlink with regular file (typechange)
    rm $"($repo)/LINK.md"
    "regular file now" | save $"($repo)/LINK.md"

    cd $repo
    let issues = (detect-issues)
    assert ($issues | any {|i| ($i.action | str starts-with "restore-symlink:") }) "should detect typechanged file"
  }
}

# --- test runner ---

def main [] {
  print "Running unfuck tests..."
  let tests = (scope commands
    | where ($it.type == "custom") and ($it.name | str starts-with "test ")
    | get name)

  let test_commands = ($tests
    | each {|test_name| $"($test_name); print '  ok ($test_name)'" }
    | str join "; ")

  nu --commands $"source ($env.CURRENT_FILE); ($test_commands)"
  print $"(ansi green)All ($tests | length) tests passed(ansi reset)"
}
