---
name: eow
description: Write a weekly outcome summary for explicitly selected project repositories, using verified GitHub evidence and recorded priorities. Keep this reporting workflow separate from the planning scheduler.
user-invocable: true
allowed-tools:
  - "Bash(gh search issues *)"
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

- **Scope:** use the explicitly selected project repositories and intended
  audience. Do not infer scope from former organizations or include private
  personal work in a team update.
- **Evidence:** use bounded GitHub queries and the recorded plan. Read files
  with the available read tool; do not create ad-hoc collectors.
- **Never fabricate.** Distinguish recorded priorities and agent proposals from
  human commitments; do not invent assignments or personal availability.
- **If unclear, ask** while the user is in the chat. If they stepped away, leave
  the section blank rather than guess.
- **It's a stakeholder doc, not a transcript of the chat.** Never paste the
  user's feedback or your own corrections into the note (e.g. "none of it new",
  "not just what merged"). Don't borrow a tool's reserved words for loose
  meaning: name the actual goal, issue, repository, or branch. Read every sentence for sense and grammar before
  finishing.

## The cardinal rule: cover the WHOLE week, every workstream

A week is mostly **in-flight work** (open PRs in review + draft), not merged.
"What merged" is a small slice. Reducing the week to the one stack that happened
to merge is the #1 failure mode of this skill.

- Gather every PR you **touched** in the week across the selected repositories, bucket by
  **workstream/goal**, and give each its own section. In-review and draft work
  gets the same billing as merged work — just tag the status.
- A goal can span repositories and a repository can hold several goals —
  group by goal, not only by repository.
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
4. **Gather across the selected repositories by activity** (queries below) and bucket the
   PRs by workstream/goal.
5. **Draft high-level** (see Structure). With a brain dump, the user's framing
   is canonical, but still reconcile against the data so no workstream is
   omitted — a TLDR is not the full inventory.
6. **Plans:** use recorded priorities and distinguish proposals from commitments.

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
  - Recorded priorities, phrased as goals; identify any unconfirmed proposals.

## Style

- **Outcomes, not PR lists.** No link pile, no PR numbers — the reader who wants
  detail opens the dailies.
- Each workstream is its own section with a status tag; **in-flight work is
  first-class**, not a footnote.
- **Reviews are a stat** in the numbers line, not prose about others' work.
- High-level repo/area labels for orientation;
  never full `org/name` paths.
- No emoji. No "I"/"we" — drop the subject. ISO dates only.

## Data queries (week range)

Run bounded queries separately for each explicitly selected `OWNER/REPO`.
Substitute the recorded reporting interval for `START..END`. Search dates select
candidates; inspect exact event timestamps before attributing work to a local
reporting window. An updated PR is not proof of a substantive contribution.

```bash
# Authored PR candidates updated during the reporting window
gh search prs --author=@me --repo=OWNER/REPO --updated=START..END --json number,title,repository,state,isDraft,createdAt,updatedAt --limit 200

# Authored PRs merged during the window
gh search prs --author=@me --repo=OWNER/REPO --merged-at=START..END --json number,title,url --limit 200

# Newly opened PRs; inspect draft/review state rather than treating them as merged
gh search prs --author=@me --repo=OWNER/REPO --created=START..END --json number,title,isDraft,state,url --limit 200

# Issues filed during the window
gh search issues --author=@me --repo=OWNER/REPO --created=START..END --json number,title,createdAt,url --limit 200

# Closed issue candidates; closure alone does not prove implementation or authorship
gh search issues --assignee=@me --repo=OWNER/REPO --state=closed --closed=START..END --json number,title,closedAt,url --limit 200

# Review candidates: verify review timestamps and substantive content before counting
gh search prs --reviewed-by=@me --repo=OWNER/REPO --updated=START..END --json number,title,url --limit 200
```

Record source coverage and deduplicate by repository and number. A result at the
limit is potentially truncated: narrow the query or report partial coverage
instead of presenting its length as a complete total. Issue closure, PR merge,
and live deployment are distinct outcomes. Do not infer an individual's work
from assignment alone.
