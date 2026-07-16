# Rewrite SKILL.md frontmatter in `dir` for Pi and Codex consumption.
#
# `ai/skills` is authored in Claude's native frontmatter. Codex rejects `<`/`>`
# in the description and ignores Claude-only keys, while Pi requires strict YAML.
# Drop the Claude-only fields, turn `->` into `to`, and JSON-quote descriptions
# into YAML-compatible scalars. Leave the body and `allowed-tools` untouched.

export def transform [content: string] {
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
      let compatible = ($line | str replace --all "->" "to")
      let normalized = if ($compatible | str starts-with "description:") {
        let description = ($compatible | str replace --regex '^description:\s*' '')
        let already_yaml = (
          ($description | str starts-with '"')
          or ($description | str starts-with "'")
          or ($description | str starts-with ">")
          or ($description | str starts-with "|")
        )
        if $already_yaml { $compatible } else { $"description: ($description | to json --raw)" }
      } else {
        $compatible
      }
      $out = ($out | append $normalized)
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
