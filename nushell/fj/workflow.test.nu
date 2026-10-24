use std/assert
use workflow.nu [strip-comments execute]
use check.test.nu [with-check-fixture]

def with-workflow-fixture [block: closure] {
  with-check-fixture --exit-code 0 {|root, bin|
    let configuration = ($root | path join test-gitconfig)
    "" | save $configuration
    "/bin/\n/home/\n/test-gitconfig\n" | save ($root | path join .gitignore)
    let editor = ($bin | path join commit-editor)
    [
      $"#!($nu.current-exe) --no-config-file"
      'def main [file: string] { "checked snapshot" | save --force $file }'
    ] | str join (char newline) | save $editor
    [
      $"#!($nu.current-exe) --no-config-file"
      'def --wrapped main [...args: string] { error make {msg: "unexpected recovery invocation"} }'
    ] | str join (char newline) | save ($bin | path join claude)
    ^chmod +x $editor ($bin | path join claude)
    with-env {GIT_CONFIG_GLOBAL: $configuration, GIT_CONFIG_NOSYSTEM: "1", GIT_EDITOR: $editor, EDITOR: $editor} {
      ^git config user.name "Fixture"
      ^git config user.email fixture@example.invalid
      ^git add -A
      ^git commit -m initial
      [
        $"#!($nu.current-exe) --no-config-file"
        $'def main [] { $env.GIT_INDEX_FILE | save --force (($bin | path join hook-index) | to nuon) }'
      ] | str join (char newline) | save ($root | path join .git hooks pre-commit)
      ^chmod +x ($root | path join .git hooks pre-commit)
      "{ checked = true; }" | save --force ($root | path join example.nix)
      do $block $root $bin
    }
  }
}

def "test execute commits the checked snapshot" [] {
  with-workflow-fixture {|root, bin|
    execute
    assert equal (^git show HEAD:example.nix) "{ checked = true; }"
    assert equal (^git status --porcelain) ""
    let hook_index = (open --raw ($bin | path join hook-index) | str trim)
    assert (not ($hook_index | path dirname | path exists)) "temporary commit index must be cleaned"
  }
}

def "test execute keeps concurrent staging outside the checked commit" [] {
  with-workflow-fixture {|root, bin|
    let real_git = (which git | first | get path)
    let index = ($root | path join .git index)
    let file = ($root | path join example.nix)
    [
      $"#!($nu.current-exe) --no-config-file"
      $"const REAL_GIT = ($real_git | to nuon)"
      $"const NORMAL_INDEX = ($index | to nuon)"
      $"const SOURCE_FILE = ($file | to nuon)"
      'def --wrapped main [...args: string] {'
      '  if ($args | first) == "commit" {'
      '    "concurrent edit" | save --force $SOURCE_FILE'
      '    with-env {GIT_INDEX_FILE: $NORMAL_INDEX} { ^$REAL_GIT add -- $SOURCE_FILE }'
      '  }'
      '  ^$REAL_GIT ...$args'
      '}'
    ] | str join (char newline) | save ($bin | path join git)
    ^chmod +x ($bin | path join git)
    execute
    assert equal (^git show HEAD:example.nix) "{ checked = true; }"
    assert equal (^git show :example.nix) "concurrent edit"
    assert equal (open --raw $file) "concurrent edit"
  }
}

def "test execute rejects edits made during checks" [] {
  with-workflow-fixture {|root, bin|
    let head = (^git rev-parse HEAD)
    let file = ($root | path join example.nix)
    [
      $"#!($nu.current-exe) --no-config-file"
      'def --wrapped main [...args: string] {'
      $'  "unchecked" | save --force ($file | to nuon)'
      '}'
    ] | str join (char newline) | save --force ($bin | path join nix)
    let rejected = try {
      execute
      false
    } catch {|err|
      $err.msg | str contains "changed during checks"
    }
    assert $rejected "must not stage and commit edits made after validation"
    assert equal (^git rev-parse HEAD) $head
    assert equal (open --raw $file) "unchecked"
  }
}

def "test execute rejects files created during checks" [] {
  with-workflow-fixture {|root, bin|
    let head = (^git rev-parse HEAD)
    let file = ($root | path join unchecked.nix)
    [
      $"#!($nu.current-exe) --no-config-file"
      'def --wrapped main [...args: string] {'
      $'  "unchecked" | save ($file | to nuon)'
      '}'
    ] | str join (char newline) | save --force ($bin | path join nix)
    let rejected = try {
      execute
      false
    } catch {|err|
      $err.msg | str contains "changed during checks"
    }
    assert $rejected
    assert equal (^git rev-parse HEAD) $head
    assert equal (open --raw $file) "unchecked"
  }
}

def "test execute supports editor arguments without evaluating shell text" [] {
  for style in [bare double single escaped literal-path] {
    with-check-fixture {|root, bin|
      let editor = ($bin | path join "fixture editor")
      let editor_arguments = ($bin | path join editor-arguments.nuon)
      let claude_arguments = ($bin | path join claude-arguments.nuon)
      [
        $"#!($nu.current-exe) --no-config-file"
        'def --wrapped main [...args: string] {'
        $'  $args | to nuon | save ($editor_arguments | to nuon)'
        '  "diagnose the failure" | save --force ($args | last)'
        '}'
      ] | str join (char newline) | save $editor
      cp $editor ($bin | path join fixture-editor)
      [
        $"#!($nu.current-exe) --no-config-file"
        'def --wrapped main [...args: string] {'
        $'  $args | to nuon | save ($claude_arguments | to nuon)'
        '}'
      ] | str join (char newline) | save ($bin | path join claude)
      ^chmod +x $editor ($bin | path join fixture-editor) ($bin | path join claude)
      let literal = '$(must-not-run)'
      let suffix = ['--wait' ('argument with spaces' | to nuon) ($literal | to nuon) ('' | to nuon)] | str join ' '
      let raw = match $style {
        bare => { $"fixture-editor ($suffix)" }
        double => { $"($editor | to nuon) ($suffix)" }
        single => { $"'($editor)' ($suffix)" }
        escaped => { $"($editor | str replace --all ' ' '\ ') ($suffix)" }
        literal-path => { $editor }
      }
      let succeeded = try {
        with-env {EDITOR: $raw} { execute }
        true
      } catch {|err|
        print -e $err.msg
        false
      }
      assert $succeeded "configured editor command must accept executable and arguments"
      let arguments = (open $editor_arguments)
      let expected = if $style == literal-path { [] } else { ['--wait' 'argument with spaces' $literal ''] }
      assert equal ($arguments | first (($arguments | length) - 1)) $expected
      assert (not ($arguments | last | path exists)) "editor prompt must be cleaned"
      let prompt = (open $claude_arguments | last)
      assert ($prompt | str contains "diagnose the failure")
      assert ($prompt | str contains "formatter stdout")
      assert ($prompt | str contains "formatter stderr")
    }
  }
}

def "test execute rejects malformed editor commands" [] {
  for case in [
    {raw: '"unterminated', message: "invalid EDITOR quoting"}
    {raw: 'fixture-editor \', message: "invalid EDITOR quoting"}
    {raw: '', message: "EDITOR executable is empty"}
    {raw: '""', message: "EDITOR executable is empty"}
  ] {
    with-check-fixture {|root, bin|
      let rejected = try {
        with-env {EDITOR: $case.raw} { execute }
        false
      } catch {|err|
        $err.msg | str contains $case.message
      }
      assert $rejected
    }
  }
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

  ^$nu.current-exe --no-config-file --no-history --commands (
    $"source ($env.CURRENT_FILE); ($test_commands)"
  )
  print (
    $"(ansi green)All ($tests | length) tests passed"
    + $"(ansi reset)"
  )
}
