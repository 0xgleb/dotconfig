use std/assert

def "test swap panes do not contain template insertion points" [] {
  let layout = (
    $env.CURRENT_FILE
    | path dirname
    | path join "layouts" "wayout.kdl"
    | open --raw
  )
  let nested_children = ($layout
    | lines
    | where { $in | str trim | str starts-with "pane { children;" })

  assert equal ($nested_children | length) 0
}

def "test zellij configuration parses" [] {
  let result = (do { ^zellij setup --check } | complete)

  assert equal $result.exit_code 0
  assert ($result.stdout | str contains "Well defined.")
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
