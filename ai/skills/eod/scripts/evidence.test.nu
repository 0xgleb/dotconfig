use std/assert

use evidence.nu [classify-commit deployment-environment deployment-pr-refs deployment-reportability extract-rai graphite-pr-reportability is-bot is-deployment-workflow linear-reportability parse-graphite-batch-spec pr-event-in-window pr-reportability reportable-review]

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

def "test deployment run links only to authored PRs sharing its head commit" [] {
  let authored_prs = [
    {repo: "ST0x-Technology/st0x.issuance", number: 12, commits: [{sha: "aaa111"}]}
    {repo: "ST0x-Technology/st0x.issuance", number: 13, commits: [{sha: "bbb222"}]}
    {repo: "ST0x-Technology/st0x.liquidity", number: 14, commits: [{sha: "aaa111"}]}
  ]
  let run = {repo: "ST0x-Technology/st0x.issuance", head_sha: "aaa111"}
  assert equal (deployment-pr-refs $run $authored_prs) ["ST0x-Technology/st0x.issuance#12"]
  assert equal (deployment-pr-refs {repo: "ST0x-Technology/st0x.issuance", head_sha: ""} $authored_prs) []
  assert equal (deployment-pr-refs {repo: "ST0x-Technology/st0x.issuance"} $authored_prs) []
}

def "test does not classify a CI run from its commit title" [] {
  assert (is-deployment-workflow "Deploy to Production")
  assert not (is-deployment-workflow "Rainix CI")
}

def "test excludes a PR created later on the same UTC date" [] {
  let cutoff = "2026-07-14T04:57:44Z" | into datetime
  let pr = {created_at: "2026-07-14T05:31:25Z", merged_at: null}
  assert not (pr-event-in-window $pr $since $cutoff)
}

def "test completed Linear status alone is context not user work" [] {
  assert equal (linear-reportability {
    created_by_user: false
    commented_by_user: false
    referenced_by_authored_pr: false
    user_framed: false
  }) "context_only"
  assert equal (linear-reportability {
    created_by_user: false
    commented_by_user: true
    referenced_by_authored_pr: false
    user_framed: false
  }) "verified_user_involvement"
}

def "test deployment workflow alone is context not user work" [] {
  assert equal (deployment-reportability {authored_pr_refs: [], user_framed: false}) "context_only"
  assert equal (deployment-reportability {authored_pr_refs: ["ST0x-Technology/repo#12"], user_framed: false}) "verified_user_involvement"
}

def "test parses only explicit bounded Graphite batch membership" [] {
  assert equal (parse-graphite-batch-spec "ST0x-Technology/st0x.issuance#290:208,239,254") {
    repo: "ST0x-Technology/st0x.issuance"
    group_number: 290
    member_numbers: [208 239 254]
  }
}

def "test closed Graphite children require exact merged batch evidence" [] {
  let pr = {
    repo: "ST0x-Technology/st0x.issuance"
    number: 208
    created_at: "2026-07-03T12:00:00Z"
    merged_at: null
    commits: []
  }
  let batch = {
    repo: "ST0x-Technology/st0x.issuance"
    group_number: 290
    member_numbers: [208 239 254]
    author_login: "app/graphite-app"
    merged_at: "2026-07-13T12:00:00Z"
  }
  assert equal (graphite-pr-reportability $pr [$batch] $since $until) "merged_via_graphite_batch"
  assert equal (graphite-pr-reportability ($pr | update number 999) [$batch] $since $until) "unverified_update"
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
