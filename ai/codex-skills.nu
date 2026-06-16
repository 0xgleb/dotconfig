# Rewrite SKILL.md frontmatter in `dir` for Codex consumption.
#
# `ai/skills` is authored in Claude's native frontmatter. Codex rejects `<`/`>`
# in the description and ignores Claude-only keys, so for each SKILL.md drop the
# `user-invocable`/`argument-hint` lines and turn `->` into `to`, leaving the
# body and `allowed-tools` (which Codex also honours) untouched.

def transform [content: string] {
  mut fence = 0
  mut out = []

  for line in ($content | lines) {
    if $line == "---" {
      $fence = $fence + 1
      $out = ($out | append $line)
      continue
    }

    if $fence == 1 {
      if ($line | str starts-with "user-invocable:") or ($line | str starts-with "argument-hint:") {
        continue
      }
      $out = ($out | append ($line | str replace --all "->" "to"))
      continue
    }

    $out = ($out | append $line)
  }

  ($out | str join "\n") + "\n"
}

def main [dir: string] {
  glob $"($dir)/**/SKILL.md" | each {|file|
    transform (open --raw $file) | save --force --raw $file
  } | ignore
}
