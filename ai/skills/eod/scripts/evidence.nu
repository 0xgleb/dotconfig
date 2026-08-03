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

export def extract-rai [text: any]: nothing -> list<string> {
  if $text == null {
    []
  } else {
    $text
    | into string
    | parse --regex '(?i)(?<identifier>RAI-\d+)'
    | get identifier
    | each { str uppercase }
    | uniq
    | sort
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
