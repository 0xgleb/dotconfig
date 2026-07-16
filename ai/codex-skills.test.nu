use std/assert

use codex-skills.nu transform

def "test transform quotes YAML descriptions" [] {
  let input = "---\nname: shape-work\ndescription: Shape work: clarify intent.\n---\n\nBody\n"
  let output = (transform $input)

  assert ($output | str contains 'description: "Shape work: clarify intent."')
  assert equal (($output | lines | skip 1 | first 2 | str join "\n" | from yaml).description) "Shape work: clarify intent."

  let quoted = (transform "---\nname: demo\ndescription: \"Already: valid\"\n---\n")
  assert ($quoted | str contains 'description: "Already: valid"')
}

def "test transform removes incompatible Claude fields" [] {
  let input = "---\nname: demo\nuser-invocable: true\nargument-hint: <task>\ndescription: Follow -> verify\n---\n"
  let output = (transform $input)

  assert (not ($output | str contains "user-invocable:"))
  assert (not ($output | str contains "argument-hint:"))
  assert ($output | str contains 'description: "Follow to verify"')
}

def "test every transformed shared skill has valid frontmatter" [] {
  let skills_dir = ($env.CURRENT_FILE | path dirname | path join "skills")

  glob $"($skills_dir)/**/SKILL.md" | each {|file|
    let frontmatter = (
      transform (open --raw $file)
      | parse --regex '(?s)^---\n(?<frontmatter>.*?)\n---'
      | first
      | get frontmatter
      | from yaml
    )
    assert ($frontmatter.name | is-not-empty)
    assert ($frontmatter.description | is-not-empty)
  } | ignore
}

def main [] {
  let tests = (scope commands
    | where ($it.type == "custom") and ($it.name | str starts-with "test ")
    | get name)

  let test_commands = ($tests
    | each {|test_name| $"($test_name)" }
    | str join "; ")

  nu --commands $"source ($env.CURRENT_FILE); ($test_commands)"
}
