export def github-failure-kind [args: list<string>, stderr: string]: nothing -> string {
  let endpoint = $args | get -o 1 | default ""
  let commit_pulls_lookup = (($args | get -o 0 | default "") == "api") and ($endpoint =~ '^repos/[^/]+/[^/]+/commits/[^/]+/pulls$')
  let normalized = $stderr | str trim
  if $commit_pulls_lookup and ($normalized =~ '(?i)HTTP 422') and ($normalized =~ '(?i)No commit found') {
    "unpublished_commit"
  } else {
    "other"
  }
}

export def in-window [timestamp: any, since: datetime, until: datetime]: nothing -> bool {
  if $timestamp == null or ($timestamp | into string | str trim | is-empty) {
    false
  } else {
    let instant = $timestamp | into datetime
    $instant >= $since and $instant <= $until
  }
}

export def classify-commit [commit: record, since: datetime, until: datetime]: nothing -> string {
  if (in-window ($commit.author_date? | default null) $since $until) {
    "authored_in_window"
  } else if (in-window ($commit.committer_date? | default null) $since $until) {
    "rewritten_or_amended_in_window"
  } else {
    "outside_window"
  }
}

export def is-bot [login: any]: nothing -> bool {
  if $login == null {
    false
  } else {
    let normalized = $login | into string | str lowercase
    ($normalized | str ends-with "[bot]") or ($normalized in [
      "coderabbitai"
      "graphite-app"
      "github-actions"
    ])
  }
}

export def reportable-review [review: record, github_user: string, pr_author: string, since: datetime, until: datetime]: nothing -> bool {
  let reviewer = $review.user_login? | default ""
  let submitted_in_window = in-window ($review.submitted_at? | default null) $since $until
  ($reviewer == $github_user) and ($pr_author != $github_user) and not (is-bot $reviewer) and $submitted_in_window
}

export def is-deployment-workflow [workflow: any]: nothing -> bool {
  if $workflow == null {
    false
  } else {
    $workflow | into string | str lowercase | str contains "deploy"
  }
}

export def pr-event-in-window [pr: record, since: datetime, until: datetime]: nothing -> bool {
  (in-window ($pr.created_at? | default null) $since $until) or (in-window ($pr.merged_at? | default null) $since $until)
}

export def pr-reportability [pr: record, since: datetime, until: datetime]: nothing -> string {
  if (in-window ($pr.created_at? | default null) $since $until) {
    "new"
  } else if (in-window ($pr.merged_at? | default null) $since $until) {
    "merged"
  } else {
    let authored_commits = ($pr.commits? | default []
      | where evidence_kind == "authored_in_window")
    if ($authored_commits | is-not-empty) {
      "verified_continued"
    } else {
      "unverified_update"
    }
  }
}

export def deployment-reportability [evidence: record]: nothing -> string {
  let refs = $evidence.authored_pr_refs? | default []
  if (($refs | is-not-empty) or ($evidence.user_framed? | default false)) {
    "verified_user_involvement"
  } else {
    "context_only"
  }
}

export def parse-graphite-batch-spec [spec: string]: nothing -> record {
  let parsed = ($spec
    | parse --regex '^(?<repo>[^#]+)#(?<group_number>\d+):(?<member_numbers>\d+(?:,\d+)*)$'
    | get -o 0
    | default null)
  if $parsed == null {
    error make {msg: $"Invalid Graphite batch spec: ($spec)"}
  }
  {
    repo: $parsed.repo
    group_number: ($parsed.group_number | into int)
    member_numbers: ($parsed.member_numbers | split row "," | each { into int })
  }
}

export def graphite-pr-reportability [pr: record, batches: list<record>, since: datetime, until: datetime]: nothing -> string {
  let ordinary = pr-reportability $pr $since $until
  if $ordinary != "unverified_update" {
    $ordinary
  } else if ($pr.state? | default "") != "CLOSED" {
    "unverified_update"
  } else {
    let matched = ($batches | any {|batch|
      let author = $batch.author_login? | default ""
      (
        (($batch.repo? | default "") == ($pr.repo? | default ""))
        and (($pr.number? | default 0) in ($batch.member_numbers? | default []))
        and ($author in ["graphite-app" "app/graphite-app"])
        and (($batch.state? | default "") == "MERGED")
        and (in-window ($batch.merged_at? | default null) $since $until)
      )
    })
    if $matched { "merged_via_graphite_batch" } else { "unverified_update" }
  }
}

export def deployment-environment [workflow: string]: nothing -> string {
  let normalized = $workflow | str lowercase
  if ($normalized | str contains "prod") {
    "production"
  } else if ($normalized | str contains "stag") {
    "staging"
  } else {
    "unspecified"
  }
}

export def deployment-pr-refs [run: record, authored_prs: list<record>]: nothing -> list<string> {
  let head_sha = $run.head_sha? | default ""
  if ($head_sha | is-empty) {
    return []
  }
  $authored_prs
  | where {|pr|
    (
      ($pr.repo == $run.repo)
      and (($pr.reportability? | default "") in ["new" "merged" "merged_via_graphite_batch" "verified_continued"])
      and ($pr.commits | any {|commit| $commit.sha == $head_sha })
    )
  }
  | each {|pr| $"($pr.repo)#($pr.number)" }
}
