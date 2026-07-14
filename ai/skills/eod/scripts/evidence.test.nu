use std/assert

use evidence.nu [classify-commit deployment-environment extract-rai is-bot pr-reportability reportable-review]

let since = "2026-07-10T00:00:00Z" | into datetime
let until = "2026-07-14T06:00:00Z" | into datetime

def "test classifies a newly authored commit as substantive evidence" [] {
  let commit = {
    author_date: "2026-07-13T12:00:00Z"
    committer_date: "2026-07-13T12:05:00Z"
  }
  assert equal (classify-commit $commit $since $until) "authored_in_window"
}

def "test does not call an old commit substantive after restack" [] {
  let commit = {
    author_date: "2026-07-03T12:00:00Z"
    committer_date: "2026-07-13T12:05:00Z"
  }
  assert equal (classify-commit $commit $since $until) "rewritten_or_amended_in_window"
}

def "test old updated PR stays unverified without an authored commit" [] {
  let pr = {
    created_at: "2026-07-03T12:00:00Z"
    merged_at: null
    commits: [{evidence_kind: "rewritten_or_amended_in_window"}]
  }
  assert equal (pr-reportability $pr $since $until) "unverified_update"
}

def "test old PR with an authored commit is verified continued work" [] {
  let pr = {
    created_at: "2026-07-03T12:00:00Z"
    merged_at: null
    commits: [{evidence_kind: "authored_in_window"}]
  }
  assert equal (pr-reportability $pr $since $until) "verified_continued"
}

def "test excludes self-authored PR comments from reviews" [] {
  let review = {user_login: "0xgleb", submitted_at: "2026-07-13T12:00:00Z"}
  assert not (reportable-review $review "0xgleb" "0xgleb" $since $until)
}

def "test includes a timestamped review on teammate work" [] {
  let review = {user_login: "0xgleb", submitted_at: "2026-07-13T12:00:00Z"}
  assert (reportable-review $review "0xgleb" "JuaniRios" $since $until)
}

def "test bot detection handles bracketed and named bots" [] {
  assert (is-bot "coderabbitai[bot]")
  assert (is-bot "graphite-app")
  assert not (is-bot "JuaniRios")
}

def "test extracts and normalizes Linear identifiers" [] {
  assert equal (extract-rai "Fixes rai-1241 and RAI-370; rai-1241 again") ["RAI-1241" "RAI-370"]
}

def "test derives deployment environment only from workflow identity" [] {
  assert equal (deployment-environment "Deploy to Production") "production"
  assert equal (deployment-environment ".github/workflows/deploy-staging.yaml") "staging"
  assert equal (deployment-environment "Deploy") "unspecified"
}

def main [] {
  print "Running EOD evidence tests..."
  let tests = (scope commands
    | where ($it.type == "custom") and ($it.name | str starts-with "test ")
    | get name)

  let test_commands = ($tests
    | each {|test_name| $"($test_name); print '  ok ($test_name)'" }
    | str join "; ")

  nu --commands $"source ($env.CURRENT_FILE); ($test_commands)"
  print $"(ansi green)All ($tests | length) tests passed(ansi reset)"
}
