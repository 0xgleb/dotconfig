use check.nu
use routing.nu [claude-project-dirname]

def claude-has-session []: nothing -> bool {
  let dirname = (claude-project-dirname $env.PWD)
  let project_dir = $"($env.HOME)/.claude/projects/($dirname)"
  ($project_dir | path exists) and ((glob $"($project_dir)/*.jsonl") | is-not-empty)
}

# Quotes group EDITOR arguments; backslashes escape outside single quotes.
# This tokenizes data without shell expansion or evaluation.
def editor-arguments [raw: string]: nothing -> list<string> {
  if ($raw | path exists) { return [$raw] }
  mut arguments = []
  mut word = ""
  mut quote = ""
  mut escaped = false
  mut started = false
  for character in ($raw | split chars) {
    if $escaped {
      $word += $character
      $escaped = false
    } else if $quote == "'" {
      if $character == "'" { $quote = "" } else { $word += $character }
    } else if $character == "\\" {
      $escaped = true
      $started = true
    } else if $quote == '"' {
      if $character == '"' { $quote = "" } else { $word += $character }
    } else if $character in ["'" '"'] {
      $quote = $character
      $started = true
    } else if $character =~ '\s' {
      if $started {
        $arguments = ($arguments | append $word)
        $word = ""
        $started = false
      }
    } else {
      $word += $character
      $started = true
    }
  }
  if $escaped or $quote != "" { error make {msg: "invalid EDITOR quoting"} }
  if $started { $arguments = ($arguments | append $word) }
  if ($arguments | is-empty) { error make {msg: "EDITOR executable is empty"} }
  if $arguments.0 == "" { error make {msg: "EDITOR executable is empty"} }
  $arguments
}

def editor-prompt [initial_content: string]: nothing -> string {
  let tmp = (mktemp --suffix .md)
  try {
    $initial_content | save --force $tmp
    let command = (editor-arguments ($env.EDITOR? | default "nvim"))
    let program = ($command | first)
    let arguments = ($command | skip 1)
    ^$program ...$arguments $tmp
    open --raw $tmp | str trim
  } finally {
    rm -f $tmp
  }
}

export def strip-comments [
  raw: string
]: nothing -> string {
  $raw
    | lines
    | where { not ($in | str starts-with "#") }
    | str join "\n"
    | str trim
}

export def execute [] {
  try {
    let root = (^git rev-parse --show-toplevel)
    cd $root
    ^git add -A
    let checked_tree = (^git write-tree)
    let result = (check run-captured)

    if $result.passed {
      print $"\n(ansi green_bold)checks passed(ansi reset)\n"
      let working = (do { ^git diff --quiet } | complete)
      if $working.exit_code not-in [0 1] {
        error make {msg: ("cannot compare working tree: " + $working.stderr)}
      }
      let current_tree = (^git write-tree)
      let untracked = (^git ls-files --others --exclude-standard)
      if $working.exit_code != 0 or $current_tree != $checked_tree or ($untracked | is-not-empty) {
        error make {msg: "repository changed during checks; rerun fj do"}
      }
      let staged = (do { ^git diff --cached --quiet } | complete)
      if $staged.exit_code == 0 {
        print "nothing to commit"
        return
      }
      if $staged.exit_code != 1 {
        error make {msg: ("cannot inspect staged changes: " + $staged.stderr)}
      }
      let directory = (mktemp -d)
      try {
        with-env {GIT_INDEX_FILE: ($directory | path join index)} {
          ^git read-tree $checked_tree
          ^git commit
        }
      } finally {
        rm -r $directory
      }
    } else {
      print $result.output
      let roast = (check skill-issue)
      print $"\n(ansi red_bold)($roast)(ansi reset)\n"

      let hint = (
        "# describe what you were trying to do"
        + " (lines starting with # are stripped)\n"
      )
      let raw_context = (editor-prompt $hint)
      let context = (strip-comments $raw_context)
      if ($context | is-empty) {
        print "no context provided, aborting"
        return
      }

      let prompt = (
        "checks failed, fix the errors:\n\n"
        + $"## context\n($context)\n\n"
        + $"## check output\n($result.output)"
      )
      if (claude-has-session) {
        ^claude --continue $prompt
      } else {
        ^claude $prompt
      }
    }
  } catch {|e|
    if ($e.msg | str contains "interrupt") {
      print "\naborted"
    } else {
      error make --unspanned {
        msg: (if ($e | get -o rendered? | is-not-empty) { $e.rendered } else { $e.msg })
      }
    }
  }
}
