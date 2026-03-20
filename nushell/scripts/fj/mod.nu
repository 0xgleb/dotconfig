use routing.nu fj-route
use check.nu
use completions.nu [fj-complete issue-complete pr-complete]
use gh.nu
export use md/

export def --wrapped main [...args: string@fj-complete] {
  let route = (fj-route ...$args)
  match $route.tool {
    "status" => {
      ^git status
      ^gt ls
    }
    "gitui" => { ^gitui ...$route.args }
    "gt" => { ^gt ...$route.args }
    "git" => { ^git ...$route.args }
    "unknown" => {
      let cmd = ($route.args | first)
      error make --unspanned { msg: $"unknown fj command: ($cmd). try `fj --help`" }
    }
  }
}

export def check [] {
  check run
}

export def --wrapped "issue list" [...args: string] {
  gh issue-list ...$args
}

export def "issue view" [id: string, --web (-w), --comments (-c)] {
  gh issue-view $id --web=$web --comments=$comments
}

export def --wrapped issue [...args: string@issue-complete] {
  ^gh issue ...$args
}

export def --wrapped "pr list" [...args: string] {
  gh pr-list ...$args
}

export def "pr view" [id?: string, --web (-w), --comments (-c)] {
  gh pr-view $id --web=$web --comments=$comments
}

export def --wrapped pr [...args: string@pr-complete] {
  ^gh pr ...$args
}
