use routing.nu fj-route
use check.nu
use completions.nu [fj-complete issue-complete pr-complete]
export use md/

export def --wrapped main [...args: string@fj-complete] {
  let route = (fj-route ...$args)
  match $route.tool {
    "status" => {
      ^git status
      ^gt ls
    }
    "gitui" => { ^gitui ...$route.args }
    "gh" => { ^gh ...$route.args }
    "gt" => { ^gt ...$route.args }
    "git" => { ^git ...$route.args }
  }
}

export def check [] {
  check run
}

export def --wrapped issue [...args: string@issue-complete] {
  ^gh issue ...$args
}

export def --wrapped pr [...args: string@pr-complete] {
  ^gh pr ...$args
}
