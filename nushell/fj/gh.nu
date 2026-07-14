# Pretty wrappers around gh issue and gh pr

const issue_view_fields = "number,title,body,author,state,labels,createdAt,assignees"
const pr_view_fields = ("number,title,body,author,state,isDraft,labels,createdAt"
  + ",headRefName,baseRefName,additions,deletions,changedFiles,latestReviews")

def format-issue-view [data: record] {
  let labels = if ($data.labels | is-empty) { "" } else {
    $"\nlabels: ($data.labels | get name | str join ', ')"
  }
  let state = ($data.state | str lowercase)

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

def format-pr-view [data: record] {
  let labels = if ($data.labels | is-empty) { "" } else {
    $"\nlabels: ($data.labels | get name | str join ', ')"
  }
  let state = if $data.isDraft { "draft" } else { $data.state | str lowercase }
  let reviews = if ($data.latestReviews | is-empty) { "" } else {
    let reviewers = ($data.latestReviews
      | each {|r| $"($r.author?.login? | default '?') \(($r.state | str lowercase))" }
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
