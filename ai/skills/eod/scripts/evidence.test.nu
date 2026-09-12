use std/assert

use evidence.nu [classify-commit deployment-environment deployment-pr-refs deployment-reportability github-failure-kind graphite-pr-reportability is-bot is-deployment-workflow parse-graphite-batch-spec pr-event-in-window pr-reportability reportable-review]

let since = "2026-07-10T00:00:00Z" | into datetime
let until = "2026-07-14T06:00:00Z" | into datetime

def "test only a missing commit pulls lookup is classified as unpublished local evidence" [] {
  let args = ["api" "repos/example/service/commits/abc123/pulls"]
  assert equal (github-failure-kind $args "gh: No commit found for SHA abc123 (HTTP 422)") "unpublished_commit"
  assert equal (github-failure-kind $args "gh: Validation Failed (HTTP 422)") "other"
  assert equal (github-failure-kind ["pr" "view" "123"] "gh: No commit found (HTTP 422)") "other"
}

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
  assert (reportable-review $review "0xgleb" "teammate" $since $until)
}

def "test bot detection handles bracketed and named bots" [] {
  assert (is-bot "coderabbitai[bot]")
  assert (is-bot "graphite-app")
  assert not (is-bot "teammate")
}

def "test derives deployment environment only from workflow identity" [] {
  assert equal (deployment-environment "Deploy to Production") "production"
  assert equal (deployment-environment ".github/workflows/deploy-staging.yaml") "staging"
  assert equal (deployment-environment "Deploy") "unspecified"
}

def "test deployment run links only to authored PRs sharing its head commit" [] {
  let authored_prs = [
    {repo: "example/service", number: 12, reportability: "verified_continued", commits: [{sha: "aaa111"}]}
    {repo: "example/service", number: 13, reportability: "new", commits: [{sha: "bbb222"}]}
    {repo: "example/other", number: 14, reportability: "merged", commits: [{sha: "aaa111"}]}
    {repo: "example/service", number: 15, reportability: "unverified_update", commits: [{sha: "aaa111"}]}
    {repo: "example/service", number: 16, commits: [{sha: "aaa111"}]}
  ]
  let run = {repo: "example/service", head_sha: "aaa111"}
  assert equal (deployment-pr-refs $run $authored_prs) ["example/service#12"]
  assert equal (deployment-pr-refs {repo: "example/service", head_sha: ""} $authored_prs) []
  assert equal (deployment-pr-refs {repo: "example/service"} $authored_prs) []
}

def "test does not classify a CI run from its commit title" [] {
  assert (is-deployment-workflow "Deploy to Production")
  assert not (is-deployment-workflow "Project CI")
}

def "test excludes a PR created later on the same UTC date" [] {
  let cutoff = "2026-07-14T04:57:44Z" | into datetime
  let pr = {created_at: "2026-07-14T05:31:25Z", merged_at: null}
  assert not (pr-event-in-window $pr $since $cutoff)
}

def "test deployment workflow alone is context not user work" [] {
  assert equal (deployment-reportability {authored_pr_refs: [], user_framed: false}) "context_only"
  assert equal (deployment-reportability {authored_pr_refs: ["example/service#12"], user_framed: false}) "verified_user_involvement"
}

def "test parses only explicit bounded Graphite batch membership" [] {
  assert equal (parse-graphite-batch-spec "example/service#290:208,239,254") {
    repo: "example/service"
    group_number: 290
    member_numbers: [208 239 254]
  }
}

def "test closed Graphite children require exact merged batch evidence" [] {
  let pr = {
    repo: "example/service"
    number: 208
    state: "CLOSED"
    created_at: "2026-07-03T12:00:00Z"
    merged_at: null
    commits: []
  }
  let batch = {
    repo: "example/service"
    group_number: 290
    member_numbers: [208 239 254]
    author_login: "app/graphite-app"
    state: "MERGED"
    merged_at: "2026-07-13T12:00:00Z"
  }
  assert equal (graphite-pr-reportability $pr [$batch] $since $until) "merged_via_graphite_batch"
  assert equal (graphite-pr-reportability ($pr | update number 999) [$batch] $since $until) "unverified_update"
  assert equal (graphite-pr-reportability ($pr | update state "OPEN") [$batch] $since $until) "unverified_update"
  assert equal (graphite-pr-reportability ($pr | reject state) [$batch] $since $until) "unverified_update"
  assert equal (graphite-pr-reportability $pr [($batch | update state "OPEN")] $since $until) "unverified_update"
  assert equal (graphite-pr-reportability $pr [($batch | reject state)] $since $until) "unverified_update"
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
