use std/assert

source md-sync-lib.nu
source md-lib.nu

def with-temp-dir [block: closure] {
  let dir = (mktemp -d)
  try {
    do $block $dir
  } catch {|e|
    print -e $"TEST ERROR: ($e.msg)"
    rm -rf $dir
    error make { msg: $e.msg }
  }
  rm -rf $dir
}

# --- compute-actions ---

def "test compute-actions finds new files" [] {
  with-temp-dir {|dir|
    let repo = $"($dir)/repo"
    let notes = $"($dir)/notes"
    mkdir $repo
    mkdir $notes
    git -C $repo init
    "# readme" | save $"($repo)/README.md"
    git -C $repo add -A
    git -C $repo commit -m "init"

    let targets = [{ name: "test-repo", path: $repo }]
    let actions = (compute-actions $targets $notes)

    assert equal ($actions | length) 1
    assert equal ($actions | first | get action) "create"
    assert equal ($actions | first | get note_file) "README.md"
  }
}

def "test compute-actions returns empty for identical files" [] {
  with-temp-dir {|dir|
    let repo = $"($dir)/repo"
    let notes = $"($dir)/notes/test-repo"
    mkdir $repo
    mkdir $notes
    git -C $repo init
    "# readme" | save $"($repo)/README.md"
    git -C $repo add -A
    git -C $repo commit -m "init"
    "# readme" | save $"($notes)/README.md"

    let targets = [{ name: "test-repo", path: $repo }]
    let actions = (compute-actions $targets $"($dir)/notes")

    assert equal ($actions | length) 0
  }
}

def "test compute-actions detects changed files" [] {
  with-temp-dir {|dir|
    let repo = $"($dir)/repo"
    let notes_dir = $"($dir)/notes/test-repo"
    mkdir $repo
    mkdir $notes_dir
    git -C $repo init
    "old content" | save $"($notes_dir)/README.md"
    sleep 100ms
    "new content" | save $"($repo)/README.md"
    git -C $repo add -A
    git -C $repo commit -m "init"

    let targets = [{ name: "test-repo", path: $repo }]
    let actions = (compute-actions $targets $"($dir)/notes")

    assert equal ($actions | length) 1
    assert equal ($actions | first | get action) "forward"
  }
}

# --- compute-actions hashes ---

def "test compute-actions includes source hash for new files" [] {
  with-temp-dir {|dir|
    let repo = $"($dir)/repo"
    let notes = $"($dir)/notes"
    mkdir $repo
    mkdir $notes
    git -C $repo init
    "# readme" | save $"($repo)/README.md"
    git -C $repo add -A
    git -C $repo commit -m "init"

    let targets = [{ name: "test-repo", path: $repo }]
    let actions = (compute-actions $targets $notes)
    let action = ($actions | first)

    assert equal $action.destination_hash null
    assert (($action.source_hash | str length) > 0)
    assert equal $action.source_hash (open --raw $"($repo)/README.md" | hash md5)
  }
}

def "test compute-actions includes both hashes for changed files" [] {
  with-temp-dir {|dir|
    let repo = $"($dir)/repo"
    let notes_dir = $"($dir)/notes/test-repo"
    mkdir $repo
    mkdir $notes_dir
    git -C $repo init
    "old content" | save $"($notes_dir)/README.md"
    sleep 100ms
    "new content" | save $"($repo)/README.md"
    git -C $repo add -A
    git -C $repo commit -m "init"

    let targets = [{ name: "test-repo", path: $repo }]
    let actions = (compute-actions $targets $"($dir)/notes")
    let action = ($actions | first)

    assert equal $action.source_hash (open --raw $"($repo)/README.md" | hash md5)
    assert equal $action.destination_hash (open --raw $"($notes_dir)/README.md" | hash md5)
    assert ($action.source_hash != $action.destination_hash)
  }
}

def "test compute-actions detects blocked empty overwrite" [] {
  with-temp-dir {|dir|
    let repo = $"($dir)/repo"
    let notes_dir = $"($dir)/notes/test-repo"
    mkdir $repo
    mkdir $notes_dir
    git -C $repo init
    "real content" | save $"($notes_dir)/README.md"
    sleep 100ms
    "" | save $"($repo)/README.md"
    git -C $repo add -A
    git -C $repo commit -m "init"

    let targets = [{ name: "test-repo", path: $repo }]
    let actions = (compute-actions $targets $"($dir)/notes")

    assert equal ($actions | length) 1
    assert equal ($actions | first | get action) "blocked"
  }
}

def "test compute-actions detects reverse sync" [] {
  with-temp-dir {|dir|
    let repo = $"($dir)/repo"
    let notes_dir = $"($dir)/notes/test-repo"
    mkdir $repo
    mkdir $notes_dir
    git -C $repo init
    "old content" | save $"($repo)/README.md"
    git -C $repo add -A
    git -C $repo commit -m "init"
    sleep 100ms
    "new content from vault" | save $"($notes_dir)/README.md"

    let targets = [{ name: "test-repo", path: $repo }]
    let actions = (compute-actions $targets $"($dir)/notes")

    assert equal ($actions | length) 1
    assert equal ($actions | first | get action) "reverse"
  }
}

# --- apply simulation ---

def "test apply creates new files from plan" [] {
  with-temp-dir {|dir|
    let repo = $"($dir)/repo"
    let notes = $"($dir)/notes"
    mkdir $repo
    mkdir $notes
    git -C $repo init
    "# hello world" | save $"($repo)/README.md"
    git -C $repo add -A
    git -C $repo commit -m "init"

    let targets = [{ name: "test-repo", path: $repo }]
    let actions = (compute-actions $targets $notes)

    $actions | where action == "create" | each {|a|
      let parent = ($a.destination | path dirname)
      mkdir $parent
      atomic-cp $a.source $a.destination
    }

    assert ($"($notes)/test-repo/README.md" | path exists)
    assert equal (open --raw $"($notes)/test-repo/README.md") "# hello world"
  }
}

def "test apply forward copies repo to vault" [] {
  with-temp-dir {|dir|
    let repo = $"($dir)/repo"
    let notes_dir = $"($dir)/notes/test-repo"
    mkdir $repo
    mkdir $notes_dir
    git -C $repo init
    "old" | save $"($notes_dir)/README.md"
    sleep 100ms
    "new from repo" | save $"($repo)/README.md"
    git -C $repo add -A
    git -C $repo commit -m "init"

    let targets = [{ name: "test-repo", path: $repo }]
    let actions = (compute-actions $targets $"($dir)/notes")

    $actions | where action == "forward" | each {|a|
      atomic-cp $a.source $a.destination
    }

    assert equal (open --raw $"($notes_dir)/README.md") "new from repo"
  }
}

def "test apply reverse copies vault to repo" [] {
  with-temp-dir {|dir|
    let repo = $"($dir)/repo"
    let notes_dir = $"($dir)/notes/test-repo"
    mkdir $repo
    mkdir $notes_dir
    git -C $repo init
    "old" | save $"($repo)/README.md"
    git -C $repo add -A
    git -C $repo commit -m "init"
    sleep 100ms
    "new from vault" | save $"($notes_dir)/README.md"

    let targets = [{ name: "test-repo", path: $repo }]
    let actions = (compute-actions $targets $"($dir)/notes")

    $actions | where action == "reverse" | each {|a|
      atomic-cp $a.destination $a.source
    }

    assert equal (open --raw $"($repo)/README.md") "new from vault"
  }
}

def "test drift detection catches modified source" [] {
  with-temp-dir {|dir|
    let repo = $"($dir)/repo"
    let notes = $"($dir)/notes"
    mkdir $repo
    mkdir $notes
    git -C $repo init
    "original" | save $"($repo)/README.md"
    git -C $repo add -A
    git -C $repo commit -m "init"

    let targets = [{ name: "test-repo", path: $repo }]
    let actions = (compute-actions $targets $notes)
    let action = ($actions | first)

    "modified after plan" | save --force $"($repo)/README.md"

    let current_hash = (open --raw $"($repo)/README.md" | hash md5)
    assert ($current_hash != $action.source_hash)
  }
}

# --- action-diff ---

def "test action-diff create shows all lines as additions" [] {
  with-temp-dir {|dir|
    # Separate paragraphs (blank line between) so `deno fmt` can't reflow them
    # onto one line, which would make `+line two` no longer its own diff line.
    "line one\n\nline two\n" | save $"($dir)/new.md"
    let action = {
      action: "create"
      repo_name: "test"
      note_file: "new.md"
      source: $"($dir)/new.md"
      destination: $"($dir)/notes/new.md"
      source_hash: "abc"
      destination_hash: null
      adds: 2
      dels: 0
    }
    let output = (action-diff $action)
    assert ($output | str contains "+line one")
    assert ($output | str contains "+line two")
  }
}

def "test action-diff forward shows unified diff" [] {
  with-temp-dir {|dir|
    "old content" | save $"($dir)/dest.md"
    "new content" | save $"($dir)/source.md"
    let action = {
      action: "forward"
      repo_name: "test"
      note_file: "file.md"
      source: $"($dir)/source.md"
      destination: $"($dir)/dest.md"
      source_hash: "abc"
      destination_hash: "def"
      adds: 1
      dels: 1
    }
    let output = (action-diff $action)
    assert ($output | str contains "-old content")
    assert ($output | str contains "+new content")
  }
}

def "test action-diff reverse shows unified diff" [] {
  with-temp-dir {|dir|
    "repo version" | save $"($dir)/source.md"
    "vault version" | save $"($dir)/dest.md"
    let action = {
      action: "reverse"
      repo_name: "test"
      note_file: "file.md"
      source: $"($dir)/source.md"
      destination: $"($dir)/dest.md"
      source_hash: "abc"
      destination_hash: "def"
      adds: 1
      dels: 1
    }
    let output = (action-diff $action)
    assert ($output | str contains "-repo version")
    assert ($output | str contains "+vault version")
  }
}

def "test action-diff blocked shows reason" [] {
  let action = {
    action: "blocked"
    repo_name: "test"
    note_file: "file.md"
    source: "/fake/source"
    destination: "/fake/dest"
    source_hash: "abc"
    destination_hash: "def"
    reason: "empty file would overwrite non-empty file"
    adds: 0
    dels: 0
  }
  let output = (action-diff $action)
  assert ($output | str contains "BLOCKED")
  assert ($output | str contains "empty file")
}

# --- build-targets ---

def "test build-targets discovers repos in org dir" [] {
  with-temp-dir {|dir|
    let org = $"($dir)/myorg"
    let vault = $"($dir)/vault"
    mkdir $org
    mkdir $vault

    let repo_a = $"($org)/repo-a"
    let repo_b = $"($org)/repo-b"
    mkdir $repo_a
    mkdir $repo_b
    git -C $repo_a init
    git -C $repo_b init

    let targets = (build-targets $org $vault)
    let names = ($targets | get name | sort)

    assert equal $names ["repo-a" "repo-b"]
  }
}

def "test build-targets excludes vault dir" [] {
  with-temp-dir {|dir|
    let org = $"($dir)/myorg"
    let vault = $"($org)/notes"
    mkdir $org
    mkdir $vault

    let repo = $"($org)/real-repo"
    mkdir $repo
    git -C $repo init

    git -C $vault init

    let targets = (build-targets $org $vault)
    let names = ($targets | get name)

    assert equal $names ["real-repo"]
  }
}

def "test build-targets discovers worktrees with repo prefix" [] {
  with-temp-dir {|dir|
    let org = $"($dir)/myorg"
    let vault = $"($dir)/vault"
    mkdir $org
    mkdir $vault

    let repo = $"($org)/myrepo"
    mkdir $repo
    git -C $repo init

    let wt = $"($repo)/.worktrees/feat/cool-feature"
    mkdir $wt
    "gitdir: dummy" | save $"($wt)/.git"

    let targets = (build-targets $org $vault)
    let names = ($targets | get name | sort)

    assert equal $names ["myrepo" "myrepo/worktrees/cool-feature"]
  }
}

# --- load-config ---

def "test load-config reads orgs and vault" [] {
  with-temp-dir {|dir|
    let config_path = $"($dir)/mdaemon.nuon"
    { vault: $"($dir)/vault", orgs: [$"($dir)/org1", $"($dir)/org2"] }
      | to nuon
      | save $config_path

    let config = (load-config $config_path)

    assert equal $config.vault $"($dir)/vault"
    assert equal ($config.orgs | length) 2
  }
}

# --- multi-org targets ---

def "test build-all-targets combines multiple orgs" [] {
  with-temp-dir {|dir|
    let vault = $"($dir)/vault"
    mkdir $vault

    let org1 = $"($dir)/alpha"
    let org2 = $"($dir)/beta"
    mkdir $org1
    mkdir $org2

    let repo1 = $"($org1)/service-a"
    let repo2 = $"($org2)/service-b"
    mkdir $repo1
    mkdir $repo2
    git -C $repo1 init
    git -C $repo2 init

    let config = { vault: $vault, orgs: [$org1, $org2] }
    let targets = (build-all-targets $config)
    let names = ($targets | get name | sort)

    assert equal $names ["alpha/service-a" "beta/service-b"]
  }
}

def "test build-all-targets vault path is org/repo/file" [] {
  with-temp-dir {|dir|
    let vault = $"($dir)/vault"
    mkdir $vault

    let org = $"($dir)/st0x"
    mkdir $org
    let repo = $"($org)/liquidity"
    mkdir $repo
    git -C $repo init
    "# readme" | save $"($repo)/README.md"
    git -C $repo add -A
    git -C $repo commit -m "init"

    let config = { vault: $vault, orgs: [$org] }
    let targets = (build-all-targets $config)
    let actions = (compute-actions $targets $vault)

    assert equal ($actions | first | get destination) $"($vault)/st0x/liquidity/README.md"
  }
}

# --- symlink filtering ---

def "test md-files skips symlinks" [] {
  with-temp-dir {|dir|
    let repo = $"($dir)/repo"
    mkdir $repo
    git -C $repo init
    "# real file" | save $"($repo)/README.md"
    "# target" | save $"($dir)/target.md"
    ^ln -s $"($dir)/target.md" $"($repo)/LINK.md"
    git -C $repo add -A
    git -C $repo commit -m "init"

    let files = (md-files $repo)
    assert ($files | any {|f| $f == "README.md" })
    assert (not ($files | any {|f| $f == "LINK.md" }))
  }
}

# --- format-action ---

def "test format-action contains repo name and note file" [] {
  let action = {
    action: "forward"
    repo_name: "liquidity"
    note_file: "ROADMAP.md"
    source: "/fake/source"
    destination: "/fake/dest"
    source_hash: "abc"
    destination_hash: "def"
    adds: 5
    dels: 2
  }
  let output = (format-action $action)
  assert ($output | str contains "liquidity/ROADMAP.md")
  assert ($output | str contains "+5")
  assert ($output | str contains "-2")
}

# --- test runner ---

def main [] {
  print "Running md lib tests..."
  let tests = (scope commands
    | where ($it.type == "custom") and ($it.name | str starts-with "test ")
    | get name)

  let test_commands = ($tests
    | each {|test_name| $"($test_name); print '  ok ($test_name)'" }
    | str join "; ")

  nu --commands $"source ($env.CURRENT_FILE); ($test_commands)"
  print $"(ansi green)All ($tests | length) tests passed(ansi reset)"
}
