use std/assert

source lib.nu

def "test parse-identity returns explicit flag value" [] {
  let key = (mktemp)
  assert equal (parse-identity --identity $key) $key
  rm -f $key
}

def "test parse-identity returns SSH_IDENTITY env when no flag" [] {
  let key = (mktemp)
  with-env { SSH_IDENTITY: $key } {
    assert equal (parse-identity) $key
  }
  rm -f $key
}

def "test parse-identity prefers explicit flag over env" [] {
  let explicit = (mktemp)
  let env_key = (mktemp)
  with-env { SSH_IDENTITY: $env_key } {
    assert equal (parse-identity --identity $explicit) $explicit
  }
  rm -f $explicit $env_key
}

def "test parse-identity falls back to default when it exists" [] {
  let tmp = (mktemp -d)
  mkdir $"($tmp)/.ssh"
  touch $"($tmp)/.ssh/id_ed25519"
  with-env { HOME: $tmp, SSH_IDENTITY: "" } {
    assert equal (parse-identity) $"($tmp)/.ssh/id_ed25519"
  }
  rm -rf $tmp
}

def "test parse-identity errors when no identity available" [] {
  let tmp = (mktemp -d)
  let errored = try {
    with-env { HOME: $tmp, SSH_IDENTITY: "" } {
      parse-identity
    }
    false
  } catch {
    true
  }
  rm -rf $tmp
  assert $errored "should error when no identity is available"
}

def "test parse-identity ignores empty SSH_IDENTITY" [] {
  let tmp = (mktemp -d)
  mkdir $"($tmp)/.ssh"
  touch $"($tmp)/.ssh/id_ed25519"
  with-env { HOME: $tmp, SSH_IDENTITY: "" } {
    assert equal (parse-identity) $"($tmp)/.ssh/id_ed25519"
  }
  rm -rf $tmp
}

def "test parse-identity errors when explicit path does not exist" [] {
  let errored = try {
    parse-identity --identity "/tmp/definitely-not-a-real-path-xyz123"
    false
  } catch {
    true
  }
  assert $errored "should error when explicit identity path does not exist"
}

def "test parse-identity errors when SSH_IDENTITY path does not exist" [] {
  let errored = try {
    with-env { SSH_IDENTITY: "/tmp/definitely-not-a-real-path-xyz123" } {
      parse-identity
    }
    false
  } catch {
    true
  }
  assert $errored "should error when SSH_IDENTITY path does not exist"
}

def main [] {
  print "Running fj infra lib tests..."
  let tests = (scope commands
    | where ($it.type == "custom") and ($it.name | str starts-with "test ")
    | get name)

  let test_commands = ($tests
    | each {|test_name| $"($test_name); print '  ok ($test_name)'" }
    | str join "; ")

  nu --commands $"source ($env.CURRENT_FILE); ($test_commands)"
  print $"(ansi green)All ($tests | length) tests passed(ansi reset)"
}
