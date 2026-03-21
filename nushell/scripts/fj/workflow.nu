use check.nu
use unfuck.nu

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
    unfuck run
    let result = (check run-captured)

    if $result.passed {
      print $"\n(ansi green_bold)checks passed(ansi reset)\n"

      let msg = (editor-prompt "")
      if ($msg | is-empty) {
        print "empty commit message, aborting"
        return
      }

      git add -A
      git commit -m $msg
    } else {
      print $result.output
      let roast = (check skill-issue)
      print $"\n(ansi red_bold)($roast)(ansi reset)\n"

      let context = (editor-prompt "# describe what you were trying to do (this line will be kept)\n")
      if ($context | is-empty) or ($context | str starts-with "#") {
        print "no context provided, aborting"
        return
      }

      let prompt = $"checks failed, fix the errors:\n\n## context\n($context)\n\n## check output\n($result.output)"
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
