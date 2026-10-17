def --wrapped main [...args: string] {
  let tool = ($env.CURRENT_FILE | path basename)
  {tool: $tool, args: $args, cwd: $env.PWD} | to json --raw | save --append $env.FJ_CALLS
  "\n" | save --append $env.FJ_CALLS
  match $tool {
    "git" => {
      if $env.FJ_SCENARIO == "git-fail" { print --stderr "discovery failed"; exit 17 }
      match $args {
        ["rev-parse" "--show-toplevel"] => { print $env.FJ_TOP }
        ["worktree" "list" "--porcelain" "-z"] => {
          if $env.FJ_SCENARIO == "bad-topology" { print "invalid"; return }
          let nul = (char nul)
          let head = "HEAD 0123456789012345678901234567890123456789"
          let branch = "branch refs/heads/main"
          let path = $"worktree ($env.FJ_MAIN)"
          if $env.FJ_SCENARIO == "truncated-topology" {
            print --no-newline $"($path)($nul)($head)"
            return
          }
          let fields = (match $env.FJ_SCENARIO {
            "no-head" => { [$path $branch] }
            "bad-head" => { [$path "HEAD invalid" $branch] }
            "duplicate-head" => { [$path $head $head $branch] }
            "no-branch" => { [$path $head] }
            "bad-branch" => { [$path $head "branch invalid"] }
            "duplicate-branch" => { [$path $head $branch $branch] }
            "duplicate-worktree" => { [$path $path $head $branch] }
            "detached" => { [$path $head detached] }
            "duplicate-detached" => { [$path $head detached detached] }
            "duplicate-bare" => { [$path bare bare] }
            "detached-branch" => { [$path $head detached $branch] }
            "bare-main" | "bare-current" => { [$path bare] }
            "bare-head" => { [$path bare $head] }
            "sha256" => { [$path "HEAD 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef" $branch] }
            _ => { [$path $head $branch] }
          })
          let record = $"($fields | str join $nul)($nul)($nul)"
          print --no-newline $record
          if $env.FJ_TOP != $env.FJ_MAIN and $env.FJ_SCENARIO != "unlisted-topology" {
            print --no-newline $"worktree ($env.FJ_TOP)($nul)($head)($nul)branch refs/heads/linked($nul)($nul)"
          }
          if $env.FJ_SCENARIO == "extra-nul" { print --no-newline $nul }
          if $env.FJ_SCENARIO == "duplicate-path" {
            print --no-newline $"worktree /synthetic/other($nul)($head)($nul)($branch)($nul)($nul)($record)"
          }
        }
        ["symbolic-ref" "--quiet" "--short" "HEAD"] => {
          if $env.FJ_SCENARIO == "detached" { exit 1 }
          print $env.FJ_BRANCH
        }
        ["status"] => { print "GIT_STATUS" }
        _ => { print --stderr "unexpected git call"; exit 91 }
      }
    }
    "but" => {
      if $env.FJ_SCENARIO == "but-fail" { print --stderr "but status failed"; exit 18 }
      if $args != ["status"] { print --stderr "unexpected but call"; exit 92 }
      print "BUT_STATUS"
    }
    "gh" => {
      if $env.FJ_SCENARIO == "gh-fail" {
        print (open --raw $env.FJ_RESPONSE)
        print --stderr "tracker failed"
        exit 19
      }
      if $env.FJ_SCENARIO == "bad-review" {
        open $env.FJ_RESPONSE | upsert latestReviews [{author: {login: "reviewer"}, state: "BOGUS"}] | to json | print
        return
      }
      if $env.FJ_SCENARIO == "bad-author" {
        open $env.FJ_RESPONSE | upsert latestReviews [{author: {}, state: "APPROVED"}] | to json | print
        return
      }
      if $env.FJ_SCENARIO == "null-author" {
        open $env.FJ_RESPONSE | upsert author null | upsert latestReviews [{author: null, state: "COMMENTED"}] | to json | print
        return
      }
      if $env.FJ_SCENARIO == "invalid-number" {
        open $env.FJ_RESPONSE | upsert number (-1) | to json | print
        return
      }
      if $env.FJ_SCENARIO == "bad-json" { print "{invalid"; return }
      if $env.FJ_SCENARIO == "bad-shape" { print '{"number": -1}'; return }
      if "--json" in $args { print (open --raw $env.FJ_RESPONSE) } else { print "GH_PASSTHROUGH" }
    }
    _ => { print --stderr "unexpected executable"; exit 93 }
  }
}
