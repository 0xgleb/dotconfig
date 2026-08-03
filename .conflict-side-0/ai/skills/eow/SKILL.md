---
name: eow
description: Write the weekly update (end-of-week summary) in the Obsidian vault — high-level outcomes per workstream across the st0x/Rain family repos, sourced from Linear and GitHub. A reference for the weekly dev sync whether or not you attend the call.
user-invocable: true
allowed-tools:
  - "Bash(linear api *)"
  - "Bash(gh search prs *)"
  - "Bash(ls *)"
  - "Bash(date *)"
  - "Read"
  - "Edit"
  - "Write"
  - "AskUserQuestion"
---

# EOW Skill

## Invocation

```
/eow                 # gather the week yourself, write the note
/eow <brain dump>    # user-provided context frames it; still reconcile with data
```

## What this is (and how it differs from /eod)

- The weekly is a **high-level summary of the week's work, grouped by
  workstream/goal**. It's a reference for the weekly dev sync — usable live in
  the call or sent async when the call is missed.
- It is NOT a daily log and NOT a pile of PR links. The dailies (`/eod`) already
  carried the per-PR detail with links; the weekly zooms out to **outcomes per
  workstream**. If you reproduce the dailies' link dump, you've failed.

## Hard rules

- **Scope: the st0x / Rain family of orgs** — ST0x-Technology, rainlanguage, and
  sibling family orgs. NEVER the user's own personal / side-project orgs (outside
  the st0x / Rain family) — those belong in a separate update.
- **Tools: `linear`, `gh`, `gt` only.** No `git`, no `cat`, no ad-hoc scripts.
  Read files with `Read`.
- **Never fabricate.** Plans = only what the user states; don't invent next
  steps and don't assign the user tasks.
- **If unclear, ask** while the user is in the chat. If they stepped away, leave
  the section blank rather than guess.
- **It's a stakeholder doc, not a transcript of the chat.** Never paste the
  user's feedback or your own corrections into the note (e.g. "none of it new",
  "not just what merged"). Don't borrow a tool's reserved words for loose
  meaning ("initiative", "project", "epic", "cycle" are Linear primitives;
  "stack" is Graphite). Read every sentence for sense and grammar before
  finishing.

## The cardinal rule: cover the WHOLE week, every workstream

A week is mostly **in-flight work** (open PRs in review + draft), not merged.
"What merged" is a small slice. Reducing the week to the one stack that happened
to merge is the #1 failure mode of this skill.

- Gather every PR you **touched** in the week across the family orgs, bucket by
  **workstream/goal**, and give each its own section. In-review and draft work
  gets the same billing as merged work — just tag the status.
- A goal can span repos (one "auto-recovery" workstream across liquidity +
  issuance) and a repo can hold several goals — bucket by goal, not only by repo.
- Don't mislabel in-flight execution as "planning": if a refactor/migration has
  open PRs this week, it's done work in progress, not a future plan.

## Workflow

1. **Find the file.** The weekly note lives under
   `~/Library/Mobile Documents/iCloud~md~obsidian/Documents/repos/notes/`
   as `YY.MM.DD@HH.MM-weekly.md`, matched by today's date prefix
   (`date +%y.%m.%d`). If none exists, ask the user — they create it in
   Obsidian. Preserve anything they've already written.
2. **Read the last 1–2 weekly notes** for house style.
3. **Determine the reporting week:** the most recent completed Mon–Sun (or
   week-to-date if run mid-week). Confirm if ambiguous. Use `START..END` (ISO).
4. **Gather across the family orgs by activity** (queries below) and bucket the
   PRs by workstream/goal.
5. **Draft high-level** (see Structure). With a brain dump, the user's framing
   is canonical, but still reconcile against the data so no workstream is
   omitted — a TLDR is not the full inventory.
6. **Plans:** only the priorities the user states.

## Structure

- `# Weekly update -- week of YYYY-MM-DD`
- `## Done last week`
  - `By the numbers:` PRs merged, opened (in review / draft), issues filed,
    closed. Numbers only — **no links**.
  - One bolded section per workstream: `**Workstream (repo/area).**` followed by
    a one-to-two-sentence **outcome**, status-tagged (merged / in review /
    draft). **No per-PR links, no PR enumeration.**
  - A brief `Also merged ...` line sweeps up tail-end items not worth a section.
  - `**Planning.**` issues filed for genuinely **future** work — not anything
    already in-flight above.
- `## Plans for this week`
  - Only the priorities the user states; phrase as goals.

## Style

- **Outcomes, not PR lists.** No link pile, no PR numbers — the reader who wants
  detail opens the dailies.
- Each workstream is its own section with a status tag; **in-flight work is
  first-class**, not a footnote.
- **Reviews are a stat** in the numbers line, not prose about others' work.
- High-level repo/area labels for orientation (`st0x.liquidity`, `raindex`);
  never full `org/name` paths.
- No emoji. No "I"/"we" — drop the subject. ISO dates only.

## Data queries (week range)

Cache `viewer.id` once (`linear api 'query { viewer { id displayName email } }'`).
Substitute `START` / `END` as the week's Monday / Sunday `YYYY-MM-DD`. For Linear
use ISO datetimes: `gte` = START `T00:00:00Z`, `lt` = the day after END.

```bash
# Master list -- every PR you touched this week across the family orgs; bucket by workstream
gh search prs --author=@me --owner=ST0x-Technology,rainlanguage --updated=START..END \
  --json number,title,repository,state,isDraft,createdAt,updatedAt --limit 200

# Merged this week (use --merged-at; the bare --merged flag is a boolean, not a date)
gh search prs --author=@me --owner=ST0x-Technology,rainlanguage --merged-at=START..END --json number --jq length

# Opened this week, split into in-review vs draft (the in-flight breakdown)
gh search prs --author=@me --owner=ST0x-Technology,rainlanguage --created=START..END --json number --jq length
gh search prs --author=@me --owner=ST0x-Technology,rainlanguage --state=open --created=START..END \
  --json number,isDraft --jq '[.[] | select(.isDraft==false)] | length'   # in review
gh search prs --author=@me --owner=ST0x-Technology,rainlanguage --state=open --created=START..END \
  --json number,isDraft --jq '[.[] | select(.isDraft==true)] | length'    # draft

# Issues created this week (linear api has NO --jq -- fetch identifiers and count the nodes)
linear api 'query($u: ID!, $a: DateTimeOrDuration!, $b: DateTimeOrDuration!) {
  issues(filter: { creator: { id: { eq: $u } }, createdAt: { gte: $a, lt: $b } }, first: 250) {
    nodes { identifier }
  }
}' --variable u=<id> --variable a=<START-iso> --variable b=<END+1-iso>

# Issues completed this week
linear api 'query($u: ID!, $a: DateTimeOrDuration!, $b: DateTimeOrDuration!) {
  issues(filter: { assignee: { id: { eq: $u } }, completedAt: { gte: $a, lt: $b } }, first: 250) {
    nodes { identifier title }
  }
}' --variable u=<id> --variable a=<START-iso> --variable b=<END+1-iso>

# Reviews: count only (stat). NOISY -- verify before citing (see /eod review-noise note).
gh search prs --reviewed-by=@me --owner=ST0x-Technology,rainlanguage --updated=START..END --json number --jq length
```

(`--owner` takes comma-separated orgs; add sibling family orgs as needed, never
the user's own personal orgs.)
