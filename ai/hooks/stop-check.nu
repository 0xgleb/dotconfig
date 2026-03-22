use std/log

export def doc-recently-changed [doc_path: string, now: int, threshold: int = 300] -> bool {
  if not ($doc_path | path exists) { return false }

  let last_mod = (ls -l $doc_path | first | get modified | into int) // 1_000_000_000
  ($now - $last_mod) < $threshold
}

export def gather-context [input: record, now: int] -> record {
  let cwd = ($input.cwd? | default ".")
  let repo = ($cwd | path basename)
  let branch = try { git -C $cwd rev-parse --abbrev-ref HEAD } catch { "unknown" }
  let pr = try { gh pr view --json number --jq '.number' } catch { "unknown" }
  let issue = try {
    gh issue list --assignee @me --state open --json number --jq '.[0].number'
  } catch { "unknown" }
  let doc_path = [$cwd ".claude" "handoff.md"] | path join
  let timestamp = ($now * 1_000_000_000 | into datetime | format date "%Y-%m-%dT%H:%M:%SZ")
  let doc_changed = (doc-recently-changed $doc_path $now)

  {
    repo: $repo
    branch: $branch
    pr: $pr
    issue: $issue
    doc_path: $doc_path
    timestamp: $timestamp
    doc_changed: $doc_changed
  }
}

export def build-reason [ctx: record] -> string {
  $"STOP HOOK TRIGGERED — follow this protocol exactly:

## Context
- repo: ($ctx.repo)
- branch: ($ctx.branch)
- pr: ($ctx.pr)
- issue: ($ctx.issue)
- handoff_doc: ($ctx.doc_path)
- doc_recently_changed: ($ctx.doc_changed)
- timestamp: ($ctx.timestamp)

## Protocol

1. Check your task list for incomplete tasks you are NOT blocked on.

2. IF there are incomplete non-blocked tasks:
   - Commit any uncommitted work
   - Continue working on the next task
   - Do NOT stop

3. IF all remaining tasks are blocked \(or all complete\):
   a. If handoff doc was recently changed \(doc_recently_changed=true\), read it first — check if the user replied or if anything changed that unblocks you. If unblocked, update task list and continue working.
   b. Write \(prepend\) a new entry to the handoff doc at ($ctx.doc_path). Create the file and directory if needed. The entry format:

---

If ALL tasks are complete, prepend this:

```markdown
---
repo: ($ctx.repo)
branch: ($ctx.branch)
pr: ($ctx.pr)
issue: ($ctx.issue)
status: complete
timestamp: ($ctx.timestamp)
---

# [complete] ($ctx.timestamp)

All tasks finished.

## Summary
<what was accomplished>
```

If BLOCKED, prepend this:

```markdown
---
repo: ($ctx.repo)
branch: ($ctx.branch)
pr: ($ctx.pr)
issue: ($ctx.issue)
status: blocked
timestamp: ($ctx.timestamp)
---

# [blocked] ($ctx.timestamp)

## Why still blocked
<explain what is blocking you and why>

## Questions
### Q1: <question>

**Response:**


### Q2: <question>

**Response:**


## Summary
<what was accomplished so far>
```

   c. After writing, commit the handoff doc and any other uncommitted work
   d. Then stop

IMPORTANT: The handoff doc is prepend-only. Read existing content and place the new entry ABOVE it. Never delete or modify previous entries."
}

export def build-decision [input: record, now: int] -> record {
  if ($input.stop_hook_active? | default false) {
    return { decision: "allow" }
  }

  let ctx = (gather-context $input $now)
  { decision: "block", reason: (build-reason $ctx) }
}

def main [] {
  let input = ($in | from json)
  let now = (date now | into int) // 1_000_000_000
  build-decision $input $now | to json --raw
}
