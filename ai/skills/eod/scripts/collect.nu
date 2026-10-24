use evidence.nu [classify-commit deployment-environment deployment-pr-refs deployment-reportability github-failure-kind graphite-pr-reportability in-window is-bot is-deployment-workflow parse-graphite-batch-spec pr-event-in-window reportable-review]

def run-gh-json [args: list<string>]: nothing -> record {
  let result = do { ^gh ...$args } | complete
  if $result.exit_code != 0 {
    {
      ok: false
      data: null
      error: "GitHub command failed"
      error_kind: (github-failure-kind $args $result.stderr)
      exit_code: $result.exit_code
    }
  } else {
    let output = $result.stdout | str trim
    if ($output | is-empty) {
      {ok: true, data: [], error: null, exit_code: 0}
    } else {
      try {
        {ok: true, data: ($output | from json), error: null, exit_code: 0}
      } catch {
        {ok: false, data: null, error: "GitHub returned invalid JSON", exit_code: 0}
      }
    }
  }
}

def first-line [text: any]: nothing -> string {
  if $text == null or ($text | into string | is-empty) {
    ""
  } else {
    $text | into string | lines | first
  }
}

def collect-git [workspace: path, since: datetime, until: datetime, since_text: string, until_text: string]: nothing -> record {
  let email_result = do { ^git config --global user.email } | complete
  if $email_result.exit_code != 0 or ($email_result.stdout | str trim | is-empty) {
    return {status: "unavailable", error: "Git author email is not configured", repos: []}
  }

  let git_email = $email_result.stdout | str trim
  let repos = (glob ($workspace | path join "*/.git")
    | each { path dirname }
    | sort)

  let activity = ($repos | each {|repo|
    let log_result = (do {
      ^git -C $repo log '--exclude=refs/stash' --all $"--since=($since_text)" $"--until=($until_text)" $"--author=($git_email)" '--pretty=format:%H%x09%s%x09%aI%x09%cI%x09%D'
    } | complete)

    let commits = if $log_result.exit_code != 0 {
      []
    } else {
      $log_result.stdout
      | lines
      | where { str trim | is-not-empty }
      | each {|line|
        let fields = $line | split row (char tab)
        if ($fields | length) < 5 {
          null
        } else {
          let commit = {
            sha: $fields.0
            subject: $fields.1
            author_date: $fields.2
            committer_date: $fields.3
            refs: $fields.4
          }
          $commit | insert evidence_kind (classify-commit $commit $since $until)
        }
      }
      | compact
      | where evidence_kind != "outside_window"
    }

    if ($commits | is-empty) {
      null
    } else {
      {repo: ($repo | path basename), path: $repo, commits: $commits}
    }
  } | compact)

  {status: "available", error: null, author_email: $git_email, repos: $activity}
}

def normalize-commit [commit: record, since: datetime, until: datetime]: nothing -> record {
  let normalized = {
    sha: ($commit.oid? | default ($commit.sha? | default ""))
    subject: ($commit.messageHeadline? | default (first-line ($commit | get -o commit.message)))
    author_date: ($commit.authoredDate? | default ($commit | get -o commit.author.date))
    committer_date: ($commit.committedDate? | default ($commit | get -o commit.committer.date))
  }
  $normalized | insert evidence_kind (classify-commit $normalized $since $until)
}

def normalize-review [review: record]: nothing -> record {
  let login = $review | get -o author.login | default ($review | get -o user.login)
  {
    user_login: $login
    submitted_at: ($review.submittedAt? | default ($review.submitted_at? | default null))
    state: ($review.state? | default "")
    is_bot: (is-bot $login)
  }
}

def collect-authored-pr [candidate: record, graphite_batches: list<record>, since: datetime, until: datetime]: nothing -> record {
  let repo = $candidate.repository.nameWithOwner
  let number = $candidate.number | into string
  let detail_result = run-gh-json [
    "pr" "view" $number "--repo" $repo "--json"
    "number,title,body,url,state,isDraft,reviewRequests,createdAt,updatedAt,mergedAt,author,commits,reviews"
  ]

  let detail = if $detail_result.ok { $detail_result.data } else { $candidate }
  let commits = ($detail.commits? | default []
    | each {|commit| normalize-commit $commit $since $until })
  let reviews = ($detail.reviews? | default []
    | each {|review| normalize-review $review }
    | where {|review| in-window $review.submitted_at $since $until })
  let pr = {
    repo: $repo
    number: $candidate.number
    title: ($detail.title? | default $candidate.title)
    url: ($detail.url? | default $candidate.url)
    author: ($detail | get -o author.login | default ($candidate | get -o author.login))
    state: ($detail.state? | default $candidate.state)
    is_draft: ($detail.isDraft? | default $candidate.isDraft)
    review_requests: ($detail.reviewRequests? | default [])
    created_at: ($detail.createdAt? | default $candidate.createdAt)
    updated_at: ($detail.updatedAt? | default $candidate.updatedAt)
    merged_at: ($detail.mergedAt? | default null)
    commits: $commits
    reviews_received: $reviews
    collection_errors: (if $detail_result.ok { [] } else { [$detail_result.error] })
  }
  $pr | insert reportability (graphite-pr-reportability $pr $graphite_batches $since $until)
}

def collect-reviews [github_user: string, owners: string, date_range: string, since: datetime, until: datetime]: nothing -> record {
  let query = "query($q: String!) {
    search(query: $q, type: ISSUE, first: 100) {
      nodes {
        ... on PullRequest {
          number title url
          repository { nameWithOwner }
          author { login }
          reviews(first: 100) { nodes { author { login } state submittedAt } }
        }
      }
    }
  }"
  let collections = ($owners | split row "," | each {|owner|
    let search = $"is:pr reviewed-by:($github_user) org:($owner) updated:($date_range)"
    let result = run-gh-json ["api" "graphql" "-f" $"query=($query)" "-f" $"q=($search)"]
    if $result.ok {
      {status: "available", error: null, prs: ($result.data.data.search.nodes | compact)}
    } else {
      {status: "unavailable", error: $result.error, prs: []}
    }
  })
  let reviews = ($collections.prs | flatten | each {|candidate|
    let repo = $candidate.repository.nameWithOwner
    $candidate.reviews.nodes
    | each {|review| normalize-review $review }
    | where {|review| reportable-review $review $github_user $candidate.author.login $since $until }
    | each {|review|
      $review | merge {
        repo: $repo
        number: $candidate.number
        title: $candidate.title
        url: $candidate.url
        pr_author: $candidate.author.login
      }
    }
  } | flatten)
  let failures = $collections | where status == "unavailable"

  if ($failures | is-empty) {
    {status: "available", error: null, reviews: $reviews}
  } else {
    {status: "partial", error: "One or more review searches failed", reviews: $reviews}
  }
}

def collect-deployments [repos: list<string>, date_range: string, since: datetime, until: datetime]: nothing -> record {
  let collections = ($repos | each {|repo|
    let runs_result = run-gh-json [
      "run" "list" "--repo" $repo "--created" $date_range
      "--json" "databaseId,workflowName,displayTitle,event,status,conclusion,createdAt,updatedAt,headBranch,headSha,url"
      "--limit" "100"
    ]
    if not $runs_result.ok {
      {status: "unavailable", runs: []}
    } else {
      let runs = ($runs_result.data
      | where {|run|
        (is-deployment-workflow ($run.workflowName? | default null)) and (in-window $run.createdAt $since $until)
      }
      | each {|run|
        let workflow = $run.workflowName? | default ""
        {
          repo: $repo
          run_id: $run.databaseId
          workflow: ($run.workflowName? | default "")
          environment: (deployment-environment $workflow)
          title: ($run.displayTitle? | default "")
          event: ($run.event? | default "")
          status: ($run.status? | default "")
          conclusion: ($run.conclusion? | default "")
          created_at: ($run.createdAt? | default null)
          updated_at: ($run.updatedAt? | default null)
          head_branch: ($run.headBranch? | default "")
          head_sha: ($run.headSha? | default "")
          url: ($run.url? | default "")
        }
      })
      {status: "available", runs: $runs}
    }
  })
  let failures = $collections | where status == "unavailable"

  {
    status: (if ($failures | is-empty) { "available" } else { "partial" })
    runs: ($collections.runs | flatten)
  }
}

def candidate-key [candidate: record]: nothing -> string {
  $"($candidate.repository.nameWithOwner)#($candidate.number)"
}

def unique-candidates [candidates: list<record>]: nothing -> list<record> {
  $candidates
  | each {|candidate| $candidate | insert evidence_key (candidate-key $candidate) }
  | uniq-by evidence_key
  | reject evidence_key
}

def collect-graphite-batches [specs: list<string>, github_user: string]: nothing -> record {
  let collections = ($specs | each {|spec|
    let parsed = parse-graphite-batch-spec $spec
    let group_result = run-gh-json [
      "pr" "view" ($parsed.group_number | into string) "--repo" $parsed.repo
      "--json" "number,title,url,state,mergedAt,author"
    ]
    let member_results = ($parsed.member_numbers | each {|number|
      let result = run-gh-json [
        "pr" "view" ($number | into string) "--repo" $parsed.repo
        "--json" "number,title,url,state,isDraft,createdAt,updatedAt,mergedAt,author"
      ]
      if $result.ok and (($result.data | get -o author.login) == $github_user) {
        {status: "available", candidate: ($result.data | insert repository {nameWithOwner: $parsed.repo})}
      } else if $result.ok {
        {status: "available", candidate: null}
      } else {
        {status: "unavailable", candidate: null}
      }
    })
    let member_failures = $member_results | where status == "unavailable"
    if $group_result.ok and ($member_failures | is-empty) {
      {
        status: "available"
        batch: ($parsed | merge {
          title: ($group_result.data.title? | default "")
          url: ($group_result.data.url? | default "")
          state: ($group_result.data.state? | default "")
          merged_at: ($group_result.data.mergedAt? | default null)
          author_login: ($group_result.data | get -o author.login | default "")
        })
        candidates: ($member_results.candidate | compact)
      }
    } else {
      {status: "unavailable", batch: null, candidates: []}
    }
  })
  let failures = $collections | where status == "unavailable"
  {
    status: (if ($failures | is-empty) { "available" } else { "partial" })
    batches: ($collections.batch? | default [] | compact)
    candidates: (unique-candidates ($collections.candidates? | default [] | flatten))
  }
}

def authored-search [github_user: string, owners: string, qualifier: string, date_range: string]: nothing -> record {
  run-gh-json [
    "search" "prs" $"--author=($github_user)" $"--owner=($owners)" $"--($qualifier)=($date_range)"
    "--json" "number,title,url,state,isDraft,createdAt,updatedAt,repository,author" "--limit" "100"
  ]
}

def collect-family-repositories [owners: string]: nothing -> record {
  let collections = ($owners | split row "," | each {|owner|
    let result = run-gh-json [
      "search" "repos" $"--owner=($owner)" "--json" "name,fullName" "--limit" "100"
    ]
    if $result.ok {
      {status: "available", repositories: $result.data}
    } else {
      {status: "unavailable", repositories: []}
    }
  })
  let failures = $collections | where status == "unavailable"

  {
    status: (if ($failures | is-empty) { "available" } else { "partial" })
    repositories: ($collections.repositories | flatten | uniq-by fullName)
  }
}

def collect-candidates-for-commits [commits: list<record>, github_user: string, allow_unpublished: bool]: nothing -> record {
  let lookups = ($commits | each {|commit|
    let result = run-gh-json ["api" $"repos/($commit.repo)/commits/($commit.sha)/pulls"]
    if $result.ok {
      let candidates = ($result.data
        | where {|pr| ($pr | get -o user.login) == $github_user }
        | each {|pr|
          {
            number: $pr.number
            title: ($pr.title? | default "")
            url: ($pr.html_url? | default "")
            state: ($pr.state? | default "")
            isDraft: ($pr.draft? | default false)
            createdAt: ($pr.created_at? | default null)
            updatedAt: ($pr.updated_at? | default null)
            repository: {nameWithOwner: $commit.repo}
            author: {login: ($pr | get -o user.login)}
          }
        })
      {status: "available", candidates: $candidates}
    } else if $allow_unpublished and (($result.error_kind? | default "other") == "unpublished_commit") {
      {status: "available", candidates: []}
    } else {
      {status: "unavailable", candidates: []}
    }
  })
  let failures = $lookups | where status == "unavailable"

  {
    status: (if ($failures | is-empty) { "available" } else { "partial" })
    candidates: (unique-candidates ($lookups.candidates | flatten))
  }
}

def collect-linked-candidates [git: record, github_user: string, family_repositories: list<record>, known_shas: list<string>]: nothing -> record {
  let commits = ($git.repos | each {|repo|
    let family_repo = $family_repositories | where name == $repo.repo | get -o 0 | default null
    if $family_repo == null {
      []
    } else {
      $repo.commits
      | where evidence_kind == "authored_in_window"
      | where {|commit| $commit.sha not-in $known_shas }
      | each {|commit| {repo: $family_repo.fullName, sha: $commit.sha} }
    }
  } | flatten
    | each {|commit| $commit | insert evidence_key $"($commit.repo)#($commit.sha)" }
    | uniq-by evidence_key
    | reject evidence_key)

  collect-candidates-for-commits $commits $github_user true
}

def collect-deployment-candidates [runs: list<record>, github_user: string]: nothing -> record {
  let commits = ($runs
    | where {|run| ($run.head_sha? | default "" | is-not-empty) }
    | each {|run| {repo: $run.repo, sha: $run.head_sha, evidence_key: $"($run.repo)#($run.head_sha)"} }
    | uniq-by evidence_key
    | reject evidence_key)
  let commit_collection = collect-candidates-for-commits $commits $github_user false
  let branches = ($runs
    | where {|run|
      let branch = $run.head_branch? | default ""
      ($branch | is-not-empty) and ($branch not-in ["main" "master"])
    }
    | each {|run| {repo: $run.repo, branch: $run.head_branch, evidence_key: $"($run.repo)#($run.head_branch)"} }
    | uniq-by evidence_key
    | reject evidence_key)
  let branch_lookups = ($branches | each {|branch|
    let result = run-gh-json [
      "pr" "list" "--repo" $branch.repo "--head" $branch.branch "--state" "all"
      "--json" "number,title,url,state,isDraft,createdAt,updatedAt,author" "--limit" "100"
    ]
    if $result.ok {
      let candidates = ($result.data
        | where {|pr| ($pr | get -o author.login) == $github_user }
        | each {|pr| $pr | insert repository {nameWithOwner: $branch.repo} })
      {status: "available", candidates: $candidates}
    } else {
      {status: "unavailable", candidates: []}
    }
  })
  let branch_failures = $branch_lookups | where status == "unavailable"
  let branch_candidates = $branch_lookups.candidates | flatten

  {
    status: (if $commit_collection.status == "available" and ($branch_failures | is-empty) { "available" } else { "partial" })
    candidates: (unique-candidates ($commit_collection.candidates ++ $branch_candidates))
  }
}

def collect-github [git: record, owners: string, deploy_repos: list<string>, graphite_specs: list<string>, since: datetime, until: datetime, since_date: string, until_date: string]: nothing -> record {
  let user_result = run-gh-json ["api" "user"]
  if not $user_result.ok {
    return {
      status: "unavailable"
      error: $user_result.error
      user: null
      authored_prs: []
      reviews: []
      deployments: []
      stats: {}
    }
  }

  let github_user = $user_result.data.login
  let date_range = $"($since_date)..($until_date)"
  let family_repository_collection = collect-family-repositories $owners
  let graphite_collection = collect-graphite-batches $graphite_specs $github_user
  let created_result = authored-search $github_user $owners "created" $date_range
  let merged_result = authored-search $github_user $owners "merged-at" $date_range
  if not $created_result.ok or not $merged_result.ok {
    return {
      status: "unavailable"
      error: "GitHub authored PR search failed"
      user: $github_user
      authored_prs: []
      reviews: []
      deployments: []
      stats: {}
    }
  }

  let initial_candidates = unique-candidates ($created_result.data ++ $merged_result.data ++ $graphite_collection.candidates)
  let initial_prs = ($initial_candidates
    | each {|candidate| collect-authored-pr $candidate $graphite_collection.batches $since $until }
    | where {|pr| (pr-event-in-window $pr $since $until) or $pr.reportability == "merged_via_graphite_batch" })
  let known_shas = ($initial_prs
    | each {|pr| $pr.commits | get -o sha }
    | flatten
    | compact
    | uniq)
  let linked_collection = collect-linked-candidates $git $github_user $family_repository_collection.repositories $known_shas
  let initial_keys = $initial_candidates | each {|candidate| candidate-key $candidate }
  let continued_candidates = ($linked_collection.candidates
    | where {|candidate| (candidate-key $candidate) not-in $initial_keys })
  let continued_prs = ($continued_candidates
    | each {|candidate| collect-authored-pr $candidate $graphite_collection.batches $since $until })
  let base_authored_prs = $initial_prs ++ $continued_prs
  let review_collection = collect-reviews $github_user $owners $date_range $since $until
  let activity_repos = ($base_authored_prs.repo ++ ($review_collection.reviews.repo? | default []))
  let deployment_repos = ($deploy_repos ++ $activity_repos | compact | uniq | sort)
  let deployment_collection = collect-deployments $deployment_repos $date_range $since $until
  let deployment_candidate_collection = collect-deployment-candidates $deployment_collection.runs $github_user
  let base_keys = $base_authored_prs | each {|pr| $"($pr.repo)#($pr.number)" }
  let deployment_candidates = ($deployment_candidate_collection.candidates
    | where {|candidate| (candidate-key $candidate) not-in $base_keys })
  let deployment_prs = ($deployment_candidates
    | each {|candidate| collect-authored-pr $candidate $graphite_collection.batches $since $until })
  let authored_prs = $base_authored_prs ++ $deployment_prs
  let deployments = ($deployment_collection.runs | each {|run|
    let refs = deployment-pr-refs $run $authored_prs
    let involvement = {authored_pr_refs: $refs, user_framed: false}
    $run
    | insert authored_pr_refs $refs
    | insert reportability (deployment-reportability $involvement)
  })
  let collection_failures = ($authored_prs
    | each {|pr| $pr.collection_errors }
    | flatten)
  let github_status = if (
    $review_collection.status == "available"
    and $family_repository_collection.status == "available"
    and $linked_collection.status == "available"
    and $deployment_collection.status == "available"
    and $deployment_candidate_collection.status == "available"
    and $graphite_collection.status == "available"
    and ($collection_failures | is-empty)
  ) { "available" } else { "partial" }

  let opened = $authored_prs | where {|pr| in-window $pr.created_at $since $until }
  let merged = $authored_prs | where {|pr| in-window $pr.merged_at $since $until }
  let submitted = $opened | where {|pr| (not $pr.is_draft) and ($pr.review_requests | is-not-empty) }
  let drafts = $opened | where is_draft == true
  let reviewed_prs = ($review_collection.reviews
    | each {|review| {key: $"($review.repo)#($review.number)"} }
    | uniq-by key)

  {
    status: $github_status
    error: (if $github_status == "available" { null } else { "One or more GitHub evidence checks failed" })
    user: $github_user
    authored_prs: $authored_prs
    reviews: $review_collection.reviews
    review_collection_status: $review_collection.status
    family_repository_lookup_status: $family_repository_collection.status
    linked_commit_lookup_status: $linked_collection.status
    deployment_collection_status: $deployment_collection.status
    deployment_pr_lookup_status: $deployment_candidate_collection.status
    graphite_batch_collection_status: $graphite_collection.status
    graphite_batches: $graphite_collection.batches
    deployments: $deployments
    stats: {
      opened: ($opened | length)
      submitted_for_review: ($submitted | length)
      still_draft: ($drafts | length)
      merged: ($merged | length)
      reviewed: ($reviewed_prs | length)
    }
  }
}

export def main [
  --since: string
  --until: string
  --workspace: path
  --owners: string # Comma-separated GitHub organization logins
  --deploy-repos: list<string> = []
  --graphite-batches: list<string> = []
  --output: path
] {
  if $since == null or $until == null {
    error make {msg: "--since and --until are required ISO-8601 timestamps"}
  }

  let since_instant = $since | into datetime
  let until_instant = $until | into datetime
  if $until_instant <= $since_instant {
    error make {msg: "--until must be later than --since"}
  }

  if $workspace == null or ($workspace | into string | str trim | is-empty) {
    error make {msg: "--workspace is required; select the reporting workspace explicitly"}
  }
  if $owners == null or ($owners | str trim | is-empty) {
    error make {msg: "--owners is required; select the reporting repository owners explicitly"}
  }

  let owner_names = $owners | split row "," | each { str trim }
  if ($owner_names | any {|owner| not ($owner =~ '^[A-Za-z0-9][A-Za-z0-9-]*$') }) {
    error make {msg: "--owners contains an invalid owner"}
  }
  let selected_owners = $owner_names | str join ","
  let workspace_path = $workspace | path expand
  if not ($workspace_path | path exists) or ($workspace_path | path type) != "dir" {
    error make {msg: "--workspace must be an existing directory"}
  }
  let since_date = $since_instant | format date "%Y-%m-%d"
  let until_date = $until_instant | format date "%Y-%m-%d"

  $graphite_batches | each {|spec| parse-graphite-batch-spec $spec } | ignore

  let git = collect-git $workspace_path $since_instant $until_instant $since $until
  let github = collect-github $git $selected_owners $deploy_repos $graphite_batches $since_instant $until_instant $since_date $until_date

  let result = {
    window: {since: $since, until: $until}
    scope: {workspace: $workspace_path, owners: $owner_names}
    source_status: {
      git: $git.status
      github: $github.status
    }
    git: $git
    github: $github
    synthesis_guardrails: {
      reportable: ["new" "merged" "merged_via_graphite_batch" "verified_continued"]
      requires_user_context: ["unverified_update" "context_only"]
      forbidden_inferences: [
        "PR updatedAt alone is not work evidence"
        "committer date alone may be restack or amend"
        "PR title, body, and branch name describe scope, not the reporting-window delta"
        "GitHub issue activity is not collected by this script; verify issue evidence separately"
        "Issue closure alone is context, not evidence of user work"
        "A deployment workflow alone is context unless linked to user-authored work or canonical user framing"
        "Graphite child merges require an exact bounded batch spec and merged app/graphite-app group evidence"
        "Every synthesized count must be adjacent to exact supporting references"
      ]
    }
  }

  if $output == null {
    $result | to json
  } else {
    let output_path = $output | path expand
    let parent = $output_path | path dirname
    if not ($parent | path exists) {
      mkdir $parent
    }
    $result | to json | save --force $output_path
    print $output_path
  }
}
