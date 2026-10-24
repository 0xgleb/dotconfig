# Curated from dotconfig completions.nu at d68a19c.
export def fj-complete [context: string = ""] {
  # Nu passes the command line, including the partial argument being completed.
  # Each suggestion replaces one argument; multiword values would be quoted.
  let parents = ($context | str trim --left | split row --regex '\s+' | drop 1 | skip 1)
  let completions = (match $parents {
    [] => { [
      {value: "help", description: "Show portable fj help"}
      {value: "issue", description: "Inspect issues"}
      {value: "pr", description: "Inspect pull requests"}
    ] }
    [issue] | [pr] => { [
      {value: "list", description: "List items"}
      {value: "view", description: "View an item"}
    ] }
    _ => { [] }
  })
  {
    options: {case_sensitive: false, completion_algorithm: "fuzzy"}
    completions: $completions
  }
}
