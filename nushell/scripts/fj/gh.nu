# Pretty wrappers around gh issue and gh pr

def format-issue-view [data: record] {
  let labels = if ($data.labels | is-empty) { "" } else {
    $"\nlabels: ($data.labels | get name | str join ', ')"
  }
  let state = ($data.state | str downcase)

  [
    "---"
    $"author: ($data.author.login)"
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
  let state = if $data.isDraft { "draft" } else { $data.state | str downcase }
  let reviews = if ($data.latestReviews | is-empty) { "" } else {
    let reviewers = ($data.latestReviews | each {|review| $"($review.author.login) \(($review.state | str downcase))" } | str join ", ")
    $"\nreviews: ($reviewers)"
  }

  [
    "---"
    $"author: ($data.author.login)"
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
  let data = (^gh issue view $id --json number,title,body,author,state,labels,createdAt,assignees | from json)
  print (format-issue-view $data)
}

export def issue-list [...args: string] {
  ^gh issue list ...$args
}

export def pr-view [id?: string, --web (-w), --comments (-c)] {
  if $web {
    if $id != null { ^gh pr view $id --web } else { ^gh pr view --web }
    return
  }
  if $comments {
    if $id != null { ^gh pr view $id --comments } else { ^gh pr view --comments }
    return
  }
  let data = if $id != null {
    ^gh pr view $id --json number,title,body,author,state,isDraft,labels,createdAt,headRefName,baseRefName,additions,deletions,changedFiles,latestReviews | from json
  } else {
    ^gh pr view --json number,title,body,author,state,isDraft,labels,createdAt,headRefName,baseRefName,additions,deletions,changedFiles,latestReviews | from json
  }
  print (format-pr-view $data)
}

export def pr-list [...args: string] {
  ^gh pr list ...$args
}
