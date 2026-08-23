---
name: eod
description: Write the user's end-of-day update in the Obsidian vault from verified Git, GitHub, deployment, and Linear evidence. Use when the user invokes /eod or asks to prepare or correct a daily update.
user-invocable: true
allowed-tools:
  - "Bash(nu /Users/0xgleb/.config/ai/skills/eod/scripts/collect.nu *)"
  - "Bash(date *)"
  - "Bash(find /Users/0xgleb/Library/Mobile Documents/iCloud~md~obsidian/Documents/repos/notes *)"
  - "Read"
  - "Edit"
  - "Write"
  - "AskUserQuestion"
  - "SessionSearch"
  - "deliver_stakeholder_update"
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
- Never read raw Claude, Codex, or Pi transcript files, credential files, secret
  files, or raw environment files. Pi session history may be queried only through
  bounded `session_search` calls as described below. If deterministic evidence is
  insufficient, ask the user.
- Never infer work from a PR title, body, branch name, `updatedAt`, or committer
  date. These describe context or can be changed by a Graphite restack.
- Never infer a Linear project or workstream from wording. Group by
  `project.name`; if it is absent, leave the item ungrouped or ask. An assigned
  issue merely entering Done is context, not proof that the user worked on it;
  require a user-created issue, a user comment, a reportable authored PR link,
  or canonical user framing before promoting it into the update.
- A family deployment workflow is context, not user work by itself. Report it
  only when an exact run is linked to reportable user-authored work or canonical
  user framing identifies the user's substantive involvement.
- Do not create Linear issues or make any external mutation while running EOD,
  except the required final typed Telegram delivery described below.

## Find the note and reporting window

1. In Pi, use this exact bounded discovery command; do not request or wait for
   a `Glob` tool:

   ```bash
   find '/Users/0xgleb/Library/Mobile Documents/iCloud~md~obsidian/Documents/repos/notes' \
     -type f -name '*-eod.md' \
     ! -name '.env*' ! -iname '*credential*' ! -iname '*secret*' \
     ! -iname '*private*key*' ! -iname '*.pem' ! -iname '*.key' \
     ! -iname '*.crt' ! -iname '*.cer' ! -iname '*.p12' \
     ! -iname '*.pfx' -print
   ```

   This searches only the exact notes root for the exact EOD suffix, excludes
   secret-bearing names, and is not a broad filesystem search. Do not use
   `find` outside that root or weaken the exclusions. A harness that actually
   exposes `Glob` may use it with the same exact root, suffix, and exclusions;
   the procedure never depends on `Glob` being available.
2. Match the target by the current local `YY.MM.DD` prefix. If none or more than
   one exists, ask the user which note to use. The user creates the note in
   Obsidian.
3. Read the target and the two or three preceding EOD notes. Match their actual
   section order, density, punctuation, and repository naming. Record whether the
   explicitly selected target is an existing zero-byte file before drafting.
4. Preserve all user-written text. Text after `TLDR:` inside a template comment
   is a brain dump. Replace that whole template comment with the structured
   update while preserving its meaning and emphasis. Treat the initial read as a
   snapshot only: re-read the live target immediately before every mutation and
   reconcile any intervening manual edits.
5. Derive `since` from the previous EOD filename as that date at `00:00:00Z`.
   Capture `until` once with `date -u +%Y-%m-%dT%H:%M:%SZ`. Use those exact ISO
   timestamps for the entire run.

## Collect evidence

Run `/Users/0xgleb/.config/ai/skills/eod/scripts/collect.nu` once with explicit
`--since`, `--until`, and `--output /tmp/eod-activity.json` arguments. Read the
resulting JSON. When canonical user framing supplies exact Graphite batch group
and child PR numbers, also pass one or more bounded `--graphite-batches`
arguments in `OWNER/REPO#GROUP:CHILD,CHILD` form. Never replace this bounded
scope with broad `is:merged`, `mergedAt`, or organization-wide searches.

The collector deliberately distinguishes:

- `new`: the PR was created inside the window.
- `merged`: the PR was merged inside the window.
- `verified_continued`: an older PR contains a commit authored inside the
  window.
- `unverified_update`: GitHub says an old PR moved, but no authored commit,
  merge, or other substantive event verifies what changed.
- `merged_via_graphite_batch`: an exact child PR is CLOSED with `mergedAt: null`,
  but canonical bounded membership and a merged `app/graphite-app` group prove
  the child was part of the merge batch.
- `context_only`: Linear completion or a deployment run exists, but no evidence
  yet connects it to the user's substantive involvement.
- `rewritten_or_amended_in_window`: only the committer date moved into the
  window. Treat this as restack/amend context, never substantive work.

It also collects exact submitted review timestamps, review states, reviewer
identities, Linear `project.name`, and Actions workflows whose identity says
they are deployments.

### Recover framing from Pi sessions

After the collector succeeds, use bounded `session_search` queries for the same
reporting window and only the st0x/Rain family repositories. Search by repository,
workstream, PR/issue identifiers found by the collector, and terms from the target
note's TLDR. Do not search raw transcript files.

Normalize useful hits conceptually as compact evidence records with these fields:
`timestamp`, `project`, `session`, `kind` (`user_framing`, `user_correction`,
`verified_tool_result`, or `assistant_claim`), `summary`, `references`, and
`confidence`. Keep this shape at the procedure boundary so a future event-log
adapter can replace `session_search` without changing drafting rules; do not add an
event-sorcery dependency now and do not persist a new event log.

Use session evidence as follows:

- User requests, corrections, sequencing, attribution, and explicit status
  statements are canonical framing, just like the note's brain dump.
- Verified tool results may identify candidate commits, PRs, reviews, deploys, or
  tests to cross-check against collector evidence.
- Assistant summaries and claims are discovery hints only. They never prove work
  happened and must be corroborated by user statements or deterministic evidence.
- Conflicting session statements require the latest user correction, not the
  assistant's latest interpretation.
- Keep only compact extracted facts; never paste conversation excerpts into the
  EOD note.

If session search is unavailable, continue with the existing deterministic sources
and say that session framing was omitted. This is not equivalent to Git/GitHub or
Linear being unavailable and does not fail the evidence gate.

## Evidence gate

Before drafting, verify all of the following:

1. `source_status.git`, `source_status.github`, and `source_status.linear` are
   all `available`.
2. `github.review_collection_status`,
   `github.family_repository_lookup_status`,
   `github.linked_commit_lookup_status`, and
   `github.deployment_collection_status`,
   `github.deployment_pr_lookup_status`, and
   `github.graphite_batch_collection_status` are all `available`.
3. Every authored PR has an empty `collection_errors` list.
4. The window in the JSON exactly matches the window established above.

If any check fails, stop before editing the note. Tell the user which source or
verification failed and ask whether to retry or proceed with a specifically
named omission. Never turn a failed source into an empty section.

For `unverified_update` or `context_only` entries, do not narrate them as work
unless canonical user framing explicitly supplies the missing involvement and
delta. Otherwise omit them and name the omission in the handoff after editing.

## Review and delivery boundary

The Obsidian markdown note is the drafting and staging surface. Once the evidence
 gate passes, edit it immediately without asking for a preview, outline approval,
or pre-edit confirmation. The user may review or correct the staged file, but the
requested EOD outcome is delivery on Telegram, not the existence of the note.

After the final verification below, send the exact verified update through the
typed `deliver_stakeholder_update` tool. This lane intentionally omits the visible
agent provenance banner so the owner can forward the message unchanged; sender,
time, size, and outcome remain in private audit metadata. Do not use `report_owner`,
a dispatcher, an inbound registry request, or the retired `relay-to-owner:` frame.
Only `deliver_stakeholder_update` evidence with `outcome=delivered` proves
completion. If delivery fails, preserve the exact draft and the bounded transport
error in durable task state; do not claim the EOD is complete. Do not send it to
Slack, email, Linear, GitHub, or any other stakeholder channel.

## Draft and edit

- For an explicitly user-designated existing zero-byte target verified by `Read`,
  use `Write` once to initialize it. For every nonempty target, re-read it
  immediately before mutation and use `Edit` only on the exact placeholder or
  user-requested anchor. If that anchor changed, stop and reconcile; never
  reconstruct the note from the earlier snapshot. Never use `Write` on a
  nonempty note or overwrite any user material wholesale.
- Use meaningful stakeholder headers that state the outcome or decision area.
  Never emit generic headings such as `What Was Done` or `Review hardening`, and
  never create a one-bullet section whose heading is merely a project name or a
  collector category.
- Lead with deliverables and their state, not PR mechanics or counts.
- Follow the user's requested workstream order exactly. Otherwise order by
  stakeholder importance, not repository or query order.
- Never emit a detached stats line. Put every count in the same sentence or
  bullet as the exact supporting PR, review, issue, deployment-run, or Graphite
  batch references. If the references do not support the count one-for-one,
  omit the count.
- Report deployments only from `github.deployments` entries marked
  `verified_user_involvement`. Include environment only when the workflow
  identity establishes it; `unspecified` stays unspecified.
- Group Linear work by its returned project name only after its collector entry
  is marked `verified_user_involvement` or canonical user framing supplies that
  involvement. An issue being touched or completed today does not prove it was
  the substantive work performed today.
- When exact bounded Graphite evidence is supplied, count each child PR once and
  cite both the child PRs and the merged batch group. Do not count the group as
  an additional authored PR.
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
- relevant same-day Pi session framing was reconciled when available, and no
  assistant-only session claim became a work claim;
- deployment work is present when deployment runs are present;
- workstream ordering and attribution match the user's checkpoint correction;
- no `unverified_update`, `context_only`, or committer-date-only event became a
  work claim without canonical user framing;
- every Linear grouping matches `project.name` and every included Linear or
  deployment item has substantive user-involvement evidence;
- every count is adjacent to exact references and agrees with those references;
- Graphite children and their batch group are reconciled without double-counting;
- the final read preserves every live manual edit outside the requested anchors;
- formatting is ASCII, terse, grammatical, and consistent with recent EODs.

If any sentence cannot be traced to the user's words or the evidence JSON,
remove it or ask. Then deliver the exact verified update through
`deliver_stakeholder_update` and require `outcome=delivered` before reporting
completion.
