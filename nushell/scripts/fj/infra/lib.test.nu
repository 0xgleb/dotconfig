use std/assert

source lib.nu

# --- parse-identity ---

def "test parse-identity returns explicit flag value" [] {
  assert equal (parse-identity --identity "/tmp/explicit") "/tmp/explicit"
}

def "test parse-identity returns SSH_IDENTITY env when no flag" [] {
  with-env { SSH_IDENTITY: "/tmp/from-env" } {
    assert equal (parse-identity) "/tmp/from-env"
  }
}

def "test parse-identity prefers explicit flag over env" [] {
  with-env { SSH_IDENTITY: "/tmp/from-env" } {
    assert equal (parse-identity --identity "/tmp/explicit") "/tmp/explicit"
  }
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

# --- decrypt-vars / encrypt-vars / cleanup-vars / with-infra ---
# These shell out to external tools (rage, terraform, nix) so they're
# integration-tested by running tf-plan against a real infra directory.
# No unit tests here.

# --- test runner ---

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
