use check.nu
use routing.nu [claude-project-dirname]

def claude-has-session []: nothing -> bool {
  let dirname = (claude-project-dirname $env.PWD)
  let project_dir = $"($env.HOME)/.claude/projects/($dirname)"
  ($project_dir | path exists) and ((glob $"($project_dir)/*.jsonl") | is-not-empty)
}

def editor-prompt [initial_content: string]: nothing -> string {
  let tmp = (mktemp --suffix .md)
  $initial_content | save --force $tmp
  let editor = ($env | get -o EDITOR | default "nvim")
  try {
    ^$editor $tmp
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
    let result = (check run-captured)

    if $result.passed {
      print $"\n(ansi green_bold)checks passed(ansi reset)\n"

      ^git add -A
      let has_staged = (
        do { ^git diff --cached --quiet } | complete | get exit_code
      ) != 0
      if not $has_staged {
        print "nothing to commit"
        return
      }
      ^git commit
    } else {
      print $result.output
      let roast = (check skill-issue)
      print $"\n(ansi red_bold)($roast)(ansi reset)\n"

      let hint = "# describe what you were trying to do"
        + " (lines starting with # are stripped)\n"
      let raw_context = (editor-prompt $hint)
      let context = (strip-comments $raw_context)
      if ($context | is-empty) {
        print "no context provided, aborting"
        return
      }

      let prompt = "checks failed, fix the errors:\n\n"
        + $"## context\n($context)\n\n"
        + $"## check output\n($result.output)"
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
