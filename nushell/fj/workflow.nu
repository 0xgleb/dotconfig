use check.nu

export def strip-comments [
  raw: string
]: nothing -> string {
  $raw
    | lines
    | where { not ($in | str starts-with "#") }
    | str join "\n"
    | str trim
}

def editor-prompt [initial_content: string]: nothing -> string {
  let tmp = (mktemp --suffix .md)
  $initial_content | save --force $tmp
  let editor = ($env | get -o EDITOR | default "nvim")
  ^$editor $tmp
  let content = (open --raw $tmp | str trim)
  rm -f $tmp
  $content
}

export def run [] {
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
      ^claude --continue $prompt
    }
  } catch {|e|
    if ($e.msg | str contains "interrupt") {
      print "\naborted"
    } else {
      error make --unspanned { msg: $e.msg }
    }
  }
}
