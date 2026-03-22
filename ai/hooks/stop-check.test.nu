use std/assert

source stop-check.nu

def with-temp-dir [block: closure] {
  let dir = (mktemp -d)
  # Capture error so cleanup always runs. Nushell has no native rethrow,
  # so we reconstruct from $e.msg (stack trace / labels are lost).
  let err = (try { do $block $dir; null } catch {|e| $e })
  rm -rf $dir
  if $err != null {
    error make { msg: $err.msg }
  }
}

# --- doc-recently-changed ---

def "test doc-recently-changed returns false when file missing" [] {
  assert equal (doc-recently-changed "/nonexistent/path" 1000) false
}

def "test doc-recently-changed returns true when file is fresh" [] {
  with-temp-dir {|dir|
    let doc = $"($dir)/handoff.md"
    "content" | save $doc
    let now = (date now | into int) // 1_000_000_000
    assert equal (doc-recently-changed $doc $now) true
  }
}

def "test doc-recently-changed returns false when file is stale" [] {
  with-temp-dir {|dir|
    let doc = $"($dir)/handoff.md"
    "content" | save $doc
    let now = (date now | into int) // 1_000_000_000
    let future = $now + 600
    assert equal (doc-recently-changed $doc $future) false
  }
}

def "test doc-recently-changed respects custom threshold" [] {
  with-temp-dir {|dir|
    let doc = $"($dir)/handoff.md"
    "content" | save $doc
    let now = (date now | into int) // 1_000_000_000
    let future = $now + 50
    assert equal (doc-recently-changed $doc $future 60) true
    assert equal (doc-recently-changed $doc $future 30) false
  }
}

# --- build-decision ---

def "test build-decision allows when stop_hook_active" [] {
  let result = (build-decision { stop_hook_active: true } 0)
  assert equal $result.decision "allow"
}

def "test build-decision blocks when stop_hook_active false" [] {
  with-temp-dir {|dir|
    let now = (date now | into int) // 1_000_000_000
    let result = (build-decision { stop_hook_active: false, cwd: $dir } $now)
    assert equal $result.decision "block"
    assert ($result.reason | str contains "STOP HOOK TRIGGERED")
  }
}

def "test build-decision blocks when stop_hook_active missing" [] {
  with-temp-dir {|dir|
    let now = (date now | into int) // 1_000_000_000
    let result = (build-decision { cwd: $dir } $now)
    assert equal $result.decision "block"
  }
}

# --- build-reason ---

def "test build-reason includes context fields" [] {
  let ctx = {
    repo: "myrepo"
    branch: "feat/foo"
    pr: "42"
    issue: "15"
    doc_path: "/tmp/handoff.md"
    timestamp: "2026-03-22T14:30:00Z"
    doc_changed: false
  }
  let reason = (build-reason $ctx)
  assert ($reason | str contains "repo: myrepo")
  assert ($reason | str contains "branch: feat/foo")
  assert ($reason | str contains "pr: 42")
  assert ($reason | str contains "issue: 15")
  assert ($reason | str contains "doc_recently_changed: false")
  assert ($reason | str contains "2026-03-22T14:30:00Z")
}

def "test build-reason includes handoff templates" [] {
  let ctx = {
    repo: "r"
    branch: "b"
    pr: "1"
    issue: "2"
    doc_path: "/tmp/h.md"
    timestamp: "2026-01-01T00:00:00Z"
    doc_changed: true
  }
  let reason = (build-reason $ctx)
  assert ($reason | str contains "status: complete")
  assert ($reason | str contains "status: blocked")
  assert ($reason | str contains "doc_recently_changed: true")
  assert ($reason | str contains "prepend-only")
}

# --- test runner ---

def main [] {
  print "Running stop-check tests..."
  let tests = (scope commands
    | where ($it.type == "custom") and ($it.name | str starts-with "test ")
    | get name)

  let test_commands = ($tests
    | each {|test_name| $"print '  ok ($test_name)'; ($test_name)" }
    | str join "; ")

  nu --commands $"source ($env.CURRENT_FILE); ($test_commands)"
  print $"(ansi green)All ($tests | length) tests passed(ansi reset)"
}
