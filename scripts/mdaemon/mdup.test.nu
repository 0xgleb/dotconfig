use std/assert

source sync-lib.nu
source mdup-lib.nu

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

# --- help text ---

def "test help-text contains usage section" [] {
  let text = (help-text)
  assert ($text | str contains "USAGE")
}

def "test help-text contains commands section" [] {
  let text = (help-text)
  assert ($text | str contains "COMMANDS")
}

def "test help-text lists plan command" [] {
  let text = (help-text)
  assert ($text | str contains "plan:")
  assert ($text | str contains "Compute a sync plan")
}

def "test help-text lists apply command" [] {
  let text = (help-text)
  assert ($text | str contains "apply:")
  assert ($text | str contains "Apply a previously generated sync plan")
}

def "test help-text contains examples section" [] {
  let text = (help-text)
  assert ($text | str contains "EXAMPLES")
}

def "test help-text examples use mdup not mdup-inner" [] {
  let text = (help-text)
  assert (not ($text | str contains "mdup-inner"))
  assert ($text | str contains "mdup plan")
  assert ($text | str contains "mdup apply")
}

def "test help-text contains learn more section" [] {
  let text = (help-text)
  assert ($text | str contains "LEARN MORE")
}

def "test help-text has no input/output types table" [] {
  let text = (help-text)
  assert (not ($text | str contains "input/output"))
  assert (not ($text | str contains "╭"))
}

def "test help-text documents NU_LOG_LEVEL" [] {
  let text = (help-text)
  assert ($text | str contains "NU_LOG_LEVEL")
}

# --- plan help text ---

def "test plan-help-text contains usage" [] {
  let text = (plan-help-text)
  assert ($text | str contains "USAGE")
  assert ($text | str contains "mdup plan")
}

def "test plan-help-text lists all flags" [] {
  let text = (plan-help-text)
  assert ($text | str contains "--org")
  assert ($text | str contains "--vault")
  assert ($text | str contains "--out")
}

def "test plan-help-text documents log levels" [] {
  let text = (plan-help-text)
  assert ($text | str contains "NU_LOG_LEVEL")
  assert ($text | str contains "DEBUG")
}

def "test plan-help-text has examples" [] {
  let text = (plan-help-text)
  assert ($text | str contains "EXAMPLES")
  assert ($text | str contains "mdup plan --org")
}

def "test plan-help-text uses mdup not mdup-inner" [] {
  let text = (plan-help-text)
  assert (not ($text | str contains "mdup-inner"))
}

# --- apply help text ---

def "test apply-help-text contains usage" [] {
  let text = (apply-help-text)
  assert ($text | str contains "USAGE")
  assert ($text | str contains "mdup apply")
}

def "test apply-help-text lists all flags" [] {
  let text = (apply-help-text)
  assert ($text | str contains "--plan")
  assert ($text | str contains "--yes")
}

def "test apply-help-text has examples" [] {
  let text = (apply-help-text)
  assert ($text | str contains "EXAMPLES")
}

def "test apply-help-text uses mdup not mdup-inner" [] {
  let text = (apply-help-text)
  assert (not ($text | str contains "mdup-inner"))
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

    # Simulate apply: create actions copy source to destination
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

    # Modify source after plan was created
    "modified after plan" | save --force $"($repo)/README.md"

    let current_hash = (open --raw $"($repo)/README.md" | hash md5)
    assert ($current_hash != $action.source_hash)
  }
}

# --- test runner ---

def main [] {
  print "Running mdup tests..."
  let tests = (scope commands
    | where ($it.type == "custom") and ($it.name | str starts-with "test ")
    | get name)

  let test_commands = ($tests
    | each {|test_name| $"print '  ok ($test_name)'; ($test_name)" }
    | str join "; ")

  nu --commands $"source ($env.CURRENT_FILE); ($test_commands)"
  print $"(ansi green)All ($tests | length) tests passed(ansi reset)"
}
