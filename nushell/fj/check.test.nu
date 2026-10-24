use std/assert

source check.nu

const CHECK_IMPLEMENTATION = path self check.nu

export def with-check-fixture [block: closure, --exit-code: int = 7] {
  let root = (mktemp -d)
  let bin = ($root | path join bin)
  let home = ($root | path join home)
  try {
    mkdir $bin $home
    ^git -C $root init -b test
    ^git -C $root remote add origin https://github.com/0xgleb/dotconfig.git
    "{}" | save ($root | path join example.nix)
    [
      $"#!($nu.current-exe) --no-config-file"
      'def --wrapped main [...args: string] {'
      '  print "formatter stdout"'
      '  print -e "formatter stderr"'
      $"  exit ($exit_code)"
      '}'
    ] | str join (char newline) | save ($bin | path join nixfmt)
    [
      $"#!($nu.current-exe) --no-config-file"
      'def --wrapped main [...args: string] { print "flake check ran" }'
    ] | str join (char newline) | save ($bin | path join nix)
    ^chmod +x ($bin | path join nixfmt) ($bin | path join nix)
    with-env {HOME: $home, PATH: ([$bin] | append $env.PATH)} {
      do {
        cd $root
        do $block $root $bin
      }
    }
  } finally {
    rm -r $root
  }
}

def "test run-captured keeps real stdout and stderr" [] {
  with-check-fixture {|root, bin|
    let result = (run-captured)
    assert (not $result.passed)
    assert ($result.output | str contains "formatter stdout") "failed check stdout must be captured"
    assert ($result.output | str contains "formatter stderr") "failed check stderr must be captured"
    assert (not ($result.output | str contains "flake check ran")) "checks must stop after a failed command"
    assert equal (pwd | path expand) ($root | path expand)
  }
}

def "test run-captured preserves successful output" [] {
  with-check-fixture --exit-code 0 {|root, bin|
    let result = (run-captured)
    assert $result.passed
    assert ($result.output | str contains "formatter stdout")
    assert ($result.output | str contains "formatter stderr")
    assert ($result.output | str contains "flake check ran")
  }
}

def "test run-captured preserves interruption" [] {
  with-check-fixture --exit-code 130 {|root, bin|
    let interrupted = try {
      run-captured
      false
    } catch {|err|
      $err.msg == "interrupted"
    }
    assert $interrupted
  }
}

def "test public check execute propagates failure" [] {
  with-check-fixture {|root, bin|
    let command = [
      $"use ($CHECK_IMPLEMENTATION | to nuon) [execute]"
      'execute'
    ] | str join (char newline)
    let result = (^$nu.current-exe --no-config-file --no-history --commands $command | complete)
    assert ($result.exit_code != 0) "public check must fail when a repository check fails"
    assert ($result.stdout | str contains "formatter stdout")
    assert ($result.stderr | str contains "formatter stderr")
  }
}

def "test run-captured rejects unsupported repositories" [] {
  with-check-fixture {|root, bin|
    ^git -C $root remote set-url origin unsupported-repository
    let result = (run-captured)
    assert (not $result.passed)
    assert ($result.output | str contains "Couldn't determine what checks to run")
  }
}

def "test skill-issue returns a string from the list" [] {
  let msg = (skill-issue)
  assert ($msg | is-not-empty) "skill-issue should return a non-empty string"
  assert (($msg | str length) > 10) "skill-issue message should be reasonably long"
}

def main [] {
  print "Running check tests..."
  let tests = (scope commands
    | where ($it.type == "custom") and ($it.name | str starts-with "test ")
    | get name)
  let test_commands = ($tests
    | each {|test_name| $"($test_name); print '  ok ($test_name)'" }
    | str join "; ")
  ^$nu.current-exe --no-config-file --no-history --commands $"source ($env.CURRENT_FILE); ($test_commands)"
  print $"(ansi green)All ($tests | length) tests passed(ansi reset)"
}
