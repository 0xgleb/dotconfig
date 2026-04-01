use std/assert

def strip-comments [
  raw: string
]: nothing -> string {
  $raw
    | lines
    | where { not ($in | str starts-with "#") }
    | str join "\n"
    | str trim
}

def "test strip-comments removes comment lines" [] {
  assert equal (
    strip-comments "# comment\nactual context"
  ) "actual context"
}

def "test strip-comments preserves non-comment lines" [] {
  assert equal (
    strip-comments "no comments here"
  ) "no comments here"
}

def "test strip-comments handles only comments as empty" [] {
  assert equal (strip-comments "# just a comment") ""
}

def "test strip-comments editor template with context" [] {
  let input = (
    "# describe what you were trying to do"
    + " (lines starting with # are stripped)"
    + "\nfixing the dashboard query"
  )
  assert equal (
    strip-comments $input
  ) "fixing the dashboard query"
}

def "test strip-comments multiple comments with context" [] {
  let input = (
    "# line one\n# line two\n"
    + "my actual context\nmore context"
  )
  assert equal (
    strip-comments $input
  ) "my actual context\nmore context"
}

def "test strip-comments trims surrounding whitespace" [] {
  assert equal (
    strip-comments "\n# comment\n\ncontext\n\n"
  ) "context"
}

def "test strip-comments empty input" [] {
  assert equal (strip-comments "") ""
}

def "test strip-comments whitespace only" [] {
  assert equal (strip-comments "  \n  ") ""
}

def "test tee captures all output and propagates error" [] {
  let log_file = (mktemp --suffix .log)

  let errored = try {
    (^nu -c "print 'step 1 ok'"
      o+e>| ^tee -a $log_file)
    (^nu -c (
      "print -e 'error: mismatched types';"
      + " print -e '  expected Option<Arc<Foo>>';"
      + " exit 1"
    ) o+e>| ^tee -a $log_file)
    false
  } catch {
    true
  }

  let captured = if ($log_file | path exists) {
    open --raw $log_file | str trim
  } else {
    ""
  }
  assert $errored "should have propagated the error"
  assert ($captured | str contains "step 1 ok") (
    $"should capture stdout, got: ($captured)"
  )
  assert ($captured | str contains "mismatched types") (
    $"should capture stderr, got: ($captured)"
  )
  rm -f $log_file
}

def main [] {
  print "Running fj workflow tests..."
  let tests = (scope commands
    | where (
      ($it.type == "custom")
      and ($it.name | str starts-with "test ")
    )
    | get name)

  let test_commands = ($tests
    | each {|t|
      $"($t); print '  ok ($t)'"
    }
    | str join "; ")

  nu --commands (
    $"source ($env.CURRENT_FILE); ($test_commands)"
  )
  print (
    $"(ansi green)All ($tests | length) tests passed"
    + $"(ansi reset)"
  )
}
