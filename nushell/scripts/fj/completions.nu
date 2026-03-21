# Completions for fj subcommands

def fj-subcommands [] {
  [
    { value: "do", description: "Check -> commit on pass, claude on fail" }
    { value: "check", description: "Run repo-specific checks" }
    { value: "unfuck", description: "Fix common repo issues" }
    { value: "issue", description: "gh issue" }
    { value: "pr", description: "gh pr" }
    { value: "md", description: "Markdown vault sync" }
    { value: "ui", description: "gitui" }
    { value: "mut", description: "gt modify" }
    { value: "ss", description: "gt submit stack" }
    { value: "create", description: "gt create branch" }
    { value: "sync", description: "gt sync" }
    { value: "co", description: "gt checkout" }
    { value: "ls", description: "gt ls (stack)" }
    { value: "ll", description: "gt ll (stack detail)" }
    { value: "log", description: "gt log" }
    { value: "restack", description: "gt restack" }
    { value: "absorb", description: "gt absorb" }
    { value: "diff", description: "git diff" }
    { value: "add", description: "git add" }
    { value: "status", description: "git status" }
    { value: "stash", description: "git stash" }
    { value: "push", description: "git push" }
    { value: "pull", description: "git pull" }
    { value: "show", description: "git show" }
    { value: "blame", description: "git blame" }
  ]
}

export def fj-complete [] {
  {
    options: { case_sensitive: false, completion_algorithm: "fuzzy" }
    completions: (fj-subcommands)
  }
}

def gh-issue-subcommands [] {
  [
    { value: "list", description: "List issues" }
    { value: "create", description: "Create an issue" }
    { value: "view", description: "View an issue" }
    { value: "close", description: "Close an issue" }
    { value: "reopen", description: "Reopen an issue" }
    { value: "edit", description: "Edit an issue" }
    { value: "comment", description: "Add a comment" }
    { value: "status", description: "Show status of relevant issues" }
  ]
}

export def issue-complete [] {
  {
    options: { case_sensitive: false, completion_algorithm: "fuzzy" }
    completions: (gh-issue-subcommands)
  }
}

def gh-pr-subcommands [] {
  [
    { value: "list", description: "List pull requests" }
    { value: "create", description: "Create a pull request" }
    { value: "view", description: "View a pull request" }
    { value: "checkout", description: "Check out a pull request" }
    { value: "close", description: "Close a pull request" }
    { value: "merge", description: "Merge a pull request" }
    { value: "review", description: "Add a review" }
    { value: "comment", description: "Add a comment" }
    { value: "diff", description: "View changes" }
    { value: "status", description: "Show status of relevant PRs" }
    { value: "checks", description: "Show CI status" }
  ]
}

export def pr-complete [] {
  {
    options: { case_sensitive: false, completion_algorithm: "fuzzy" }
    completions: (gh-pr-subcommands)
  }
}
