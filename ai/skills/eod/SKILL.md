---
name: eod
description: Write the user's end-of-day update in the Obsidian vault from verified Git, GitHub, deployment, and Linear evidence. Use when the user invokes /eod or asks to prepare or correct a daily update.
user-invocable: true
allowed-tools:
  - "Bash(nu /Users/0xgleb/.config/ai/skills/eod/scripts/collect.nu *)"
  - "Bash(date *)"
  - "Glob"
  - "Read"
  - "Edit"
  - "AskUserQuestion"
---

# EOD

Write a short stakeholder update only after the evidence has passed the review
gate below. A user's brain dump, embedded TLDR, correction, ordering, and
attribution are canonical. Evidence fills gaps and supplies references; it does
not override the user's account.

## Scope

- Cover the st0x / Rain family only: `ST0x-Technology`, `rainlanguage`, and
  sibling family organizations. Exclude personal and side-project work.
- Cover everything from the most recent prior EOD through one captured `now`.
  This is not a calendar-day or rolling-24-hour report.
- Never read Claude or Codex session transcripts, credential files, secret
  files, or raw environment files. If deterministic evidence is insufficient,
  ask the user.
- Never infer work from a PR title, body, branch name, `updatedAt`, or committer
  date. These describe context or can be changed by a Graphite restack.
- Never infer a Linear project or workstream from wording. Group by
  `project.name`; if it is absent, leave the item ungrouped or ask.
- Do not create Linear issues or make any external mutation while running EOD.

## Find the note and reporting window

1. Use `Glob` in
   `/Users/0xgleb/Library/Mobile Documents/iCloud~md~obsidian/Documents/repos/notes`
   to find `*-eod.md` files. Do not run a broad filesystem search.
2. Match the target by the current local `YY.MM.DD` prefix. If none or more than
   one exists, ask the user which note to use. The user creates the note in
   Obsidian.
3. Read the target and the two or three preceding EOD notes. Match their actual
   section order, density, punctuation, and repository naming.
4. Preserve all user-written text. Text after `TLDR:` inside a template comment
   is a brain dump. Replace that whole template comment with the structured
   update while preserving its meaning and emphasis.
5. Derive `since` from the previous EOD filename as that date at `00:00:00Z`.
   Capture `until` once with `date -u +%Y-%m-%dT%H:%M:%SZ`. Use those exact ISO
   timestamps for the entire run.

## Collect evidence

Run `/Users/0xgleb/.config/ai/skills/eod/scripts/collect.nu` once with explicit
`--since`, `--until`, and `--output /tmp/eod-activity.json` arguments. Read the
resulting JSON.

The collector deliberately distinguishes:

- `new`: the PR was created inside the window.
- `merged`: the PR was merged inside the window.
- `verified_continued`: an older PR contains a commit authored inside the
  window.
- `unverified_update`: GitHub says an old PR moved, but no authored commit,
  merge, or other substantive event verifies what changed.
- `rewritten_or_amended_in_window`: only the committer date moved into the
  window. Treat this as restack/amend context, never substantive work.

It also collects exact submitted review timestamps, review states, reviewer
identities, Linear `project.name`, and Actions workflows whose identity says
they are deployments.

## Evidence gate

Before drafting, verify all of the following:

1. `source_status.git`, `source_status.github`, and `source_status.linear` are
   all `available`.
2. `github.review_collection_status`,
   `github.family_repository_lookup_status`,
   `github.linked_commit_lookup_status`, and
   `github.deployment_collection_status`, and
   `github.deployment_pr_lookup_status` are all `available`.
3. Every authored PR has an empty `collection_errors` list.
4. The window in the JSON exactly matches the window established above.

If any check fails, stop before editing the note. Tell the user which source or
verification failed and ask whether to retry or proceed with a specifically
named omission. Never turn a failed source into an empty section.

For `unverified_update` entries, do not narrate them as work unless the user's
brain dump explicitly supplies the missing delta. Otherwise omit them and name
the omission in the handoff after editing.

## Review boundary

The Obsidian markdown note is the review artifact. Once the evidence gate
passes, edit it immediately without asking for a preview, outline approval, or
pre-edit confirmation. The user reviews the file and will request corrections
thereafter.

Never send or post the update to Telegram, Slack, email, Linear, GitHub, or any
other stakeholder channel. Writing the note is the entire external boundary of
this skill.

## Draft and edit

- Use `Edit`, not `Write`, so existing user material is not replaced wholesale.
- Follow recent-note house style. The usual shape is a concrete status paragraph,
  one granular stats line, `## What Was Done`, topic-grouped bullets, and a
  compact `### Reviews` section when reviews exist.
- Lead with deliverables and their state, not PR mechanics or counts.
- Follow the user's requested workstream order exactly. Otherwise order by
  stakeholder importance, not repository or query order.
- A stats line may include nonzero counts for PRs opened, submitted for review,
  still draft, merged, reviewed, issues created, and issues completed.
- Report deployments only from `github.deployments`. Include environment only
  when the workflow identity establishes it; `unspecified` stays unspecified.
- Group Linear work by its returned project name. An issue being touched today
  does not prove it was the substantive work performed today.
- Reviews count only when the user submitted the review inside the window on
  another author's PR. Group them as Approved, Commented, or Changes-requested.
- Human and bot feedback are different. Never describe bot-only activity as
  human review feedback.
- Collapse related PR runs. One line should state a fact and its references.
- Use Graphite PR links:
  `https://app.graphite.com/github/pr/ORG/REPO/NUMBER`.
- Link every PR reference or none of them.
- Use ASCII only: no emoji, curly quotes, Unicode dashes, arrows, or ellipses.
- No first-person voice. No `Next items` unless the user supplied them.
- Aim below 1500 characters and never exceed Telegram's 4096-character limit.

## Final verification

Read the completed note once more and verify:

- every claimed delta has user confirmation or reportable evidence;
- deployment work is present when deployment runs are present;
- workstream ordering and attribution match the user's checkpoint correction;
- no `unverified_update` or committer-date-only event became a work claim;
- every Linear grouping matches `project.name`;
- stats agree with the evidence JSON;
- formatting is ASCII, terse, grammatical, and consistent with recent EODs.

If any sentence cannot be traced to the user's words or the evidence JSON,
remove it or ask.
