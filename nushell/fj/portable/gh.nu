# Pretty wrappers around gh issue and gh pr

const issue_view_fields = "number,title,body,author,state,labels,createdAt,assignees"
const pr_view_fields = ("number,title,body,author,state,isDraft,labels,createdAt"
  + ",headRefName,baseRefName,additions,deletions,changedFiles,latestReviews")

def validate-author [author: any] {
  if $author == null { return }
  if not (($author | describe) | str starts-with "record") {
    error make --unspanned {msg: "invalid tracker author"}
  }
  let login = $author.login?
  if ($login | describe) != "string" or ($login | is-empty) {
    error make --unspanned {msg: "invalid tracker author login"}
  }
}

def validate-common [data: record<number: int, title: string, body: any, author: any, state: string, labels: list<record<name: string>>, createdAt: string>] {
  if $data.number < 1 or $data.state not-in [OPEN CLOSED MERGED] {
    error make --unspanned {msg: "invalid tracker identity or state"}
  }
  if $data.body != null and ($data.body | describe) != "string" {
    error make --unspanned {msg: "invalid tracker body"}
  }
  validate-author $data.author
}

def format-issue-view [data: record] {
  validate-common $data
  if $data.state == "MERGED" { error make --unspanned {msg: "invalid tracker issue state"} }
  let labels = if ($data.labels | is-empty) { "" } else {
    $"\nlabels: ($data.labels | get name | str join ', ')"
  }
  let state = ($data.state | str downcase)

  [
    "---"
    $"author: ($data.author?.login? | default 'unknown')"
    $"issue: #($data.number)"
    $"state: ($state)"
    $"created: ($data.createdAt)($labels)"
    "---"
    ""
    $"# ($data.title)"
    ""
    ($data.body | default "")
  ] | str join "\n"
}

def format-pr-view [data: record<number: int, title: string, body: any, author: any, state: string, labels: list<record<name: string>>, createdAt: string, isDraft: bool, headRefName: string, baseRefName: string, additions: int, deletions: int, changedFiles: int, latestReviews: list<record<author: any, state: string>>>] {
  validate-common $data
  if $data.additions < 0 or $data.deletions < 0 or $data.changedFiles < 0 {
    error make --unspanned {msg: "invalid tracker change counts"}
  }
  let labels = if ($data.labels | is-empty) { "" } else {
    $"\nlabels: ($data.labels | get name | str join ', ')"
  }
  for review in $data.latestReviews {
    validate-author $review.author
    # GitHub GraphQL PullRequestReviewState.
    if $review.state not-in [PENDING COMMENTED APPROVED CHANGES_REQUESTED DISMISSED] {
      error make --unspanned {msg: "invalid tracker review state"}
    }
  }
  let state = if $data.isDraft { "draft" } else { $data.state | str downcase }
  let reviews = if ($data.latestReviews | is-empty) { "" } else {
    let reviewers = ($data.latestReviews
      | each {|r| $"($r.author?.login? | default '?') \(($r.state | str downcase))" }
      | str join ", ")
    $"\nreviews: ($reviewers)"
  }

  [
    "---"
    $"author: ($data.author?.login? | default 'unknown')"
    $"pr: #($data.number)"
    $"state: ($state)"
    $"branch: ($data.headRefName) -> ($data.baseRefName)"
    $"created: ($data.createdAt)"
    $"+($data.additions) -($data.deletions) across ($data.changedFiles) files($labels)($reviews)"
    "---"
    ""
    $"# ($data.title)"
    ""
    ($data.body | default "")
  ] | str join "\n"
}

export def issue-view [id: string, --web (-w), --comments (-c)] {
  if $web {
    ^gh issue view $id --web
    return
  }
  if $comments {
    ^gh issue view $id --comments
    return
  }
  let data = (^gh issue view $id --json $issue_view_fields | from json)
  print (format-issue-view $data)
}

export def issue-list [...args: string] {
  ^gh issue list ...$args
}

export def pr-view [id?: string, --web (-w), --comments (-c)] {
  # no id -> gh defaults to the current branch's PR
  let id_arg = if $id == null { [] } else { [$id] }

  if $web {
    ^gh pr view ...$id_arg --web
    return
  }
  if $comments {
    ^gh pr view ...$id_arg --comments
    return
  }
  let data = (^gh pr view ...$id_arg --json $pr_view_fields | from json)
  print (format-pr-view $data)
}

export def pr-list [...args: string] {
  ^gh pr list ...$args
}
