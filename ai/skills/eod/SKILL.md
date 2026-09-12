---
name: eod
description: Prepare, evidence-check, and deliver a concise stakeholder-ready end-of-day update directly on Telegram. Use when the user invokes /eod or asks to prepare, correct, approve, or deliver a daily update; never require or modify Obsidian.
user-invocable: true
allowed-tools:
  - "Bash(nu /Users/0xgleb/.config/ai/skills/eod/scripts/collect.nu *)"
  - "Bash(date *)"
  - "Read"
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

- Cover only the repositories and audience explicitly selected for this update.
  Keep private or unrelated work out of team updates; never infer scope from an
  old organization default.
- Cover everything from the most recent prior EOD through one captured `now`.
  This is not a calendar-day or rolling-24-hour report.
- Never read raw Claude, Codex, or Pi transcript files, credential files, secret
  files, or raw environment files. Pi session history may be queried only through
  bounded `session_search` calls as described below. If deterministic evidence is
  insufficient, ask the user.
- Never infer work from a PR title, body, branch name, `updatedAt`, or committer
  date. These describe context or can be changed by a history rewrite.
- Group by verified repository or canonical user framing, not a guessed project
  name. An issue merely closing is context, not proof that the user worked on it;
  require timestamped user activity, a reportable authored PR link, or canonical
  user framing before promoting it into the update.
- A family deployment workflow is context, not user work by itself. Report it
  only when an exact run is linked to reportable user-authored work or canonical
  user framing identifies the user's substantive involvement.
- Do not create tracker issues or make any external mutation while running EOD,
  except the required final typed Telegram delivery described below.

## Establish the reporting window

1. Use bounded `session_search` to find the latest successful prior EOD delivery
   and its verified reporting boundary. A typed `deliver_stakeholder_update`
   result with `outcome=delivered` is the preferred boundary; assistant claims
   alone are not evidence.
2. If no prior verified boundary is available, use an explicit starting point
   supplied by the user. If neither exists, ask for the starting point rather
   than inventing a calendar-day or rolling-24-hour window.
3. Capture `until` once with `date -u +%Y-%m-%dT%H:%M:%SZ`. Use the same exact
   `since` and `until` timestamps for collection, session searches, drafting,
   corrections, and final verification.
4. Treat any user brain dump, correction, ordering, and attribution in the
   current conversation as canonical framing. Preserve its meaning and emphasis;
   deterministic evidence fills gaps but does not rewrite the user's account.

## Collect evidence

Run `/Users/0xgleb/.config/ai/skills/eod/scripts/collect.nu` once with explicit
`--since`, `--until`, `--workspace`, and `--owners` arguments. `--owners` must
contain GitHub organization logins: automated review searches use `org:` and do
not cover individual-account owners. For user-owned repositories, obtain separate
review evidence or an explicitly approved omission; never claim empty review
activity from this unsupported scope. Create a recorded
evidence directory under the current workspace's `.tmp/` and pass its activity
JSON path through `--output`. Add `--deploy-repos` only for explicitly selected
additional deployment repositories. Read the resulting JSON.

The collector covers Git commits and GitHub PRs, reviews, and deployments. It
does not collect GitHub issue activity; verify any issue evidence separately
within the same reporting window rather than claiming an empty issue history.

When canonical user framing supplies exact historical Graphite batch group
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
- `context_only`: a deployment run exists, but no evidence
  yet connects it to the user's substantive involvement.
- `rewritten_or_amended_in_window`: only the committer date moved into the
  window. Treat this as restack/amend context, never substantive work.

It also collects exact submitted review timestamps, review states, reviewer
identities, and Actions workflows whose identity says they are deployments.

### Recover framing from Pi sessions

After the collector succeeds, use bounded `session_search` queries for the same
reporting window and only the selected repositories. Search by repository,
workstream, PR/issue identifiers found by the collector, and terms from the user's
current framing. Do not search raw transcript files.

Normalize useful hits conceptually as compact evidence records with these fields:
`timestamp`, `project`, `session`, `kind` (`user_framing`, `user_correction`,
`verified_tool_result`, or `assistant_claim`), `summary`, `references`, and
`confidence`. Keep this shape at the procedure boundary so a future event-log
adapter can replace `session_search` without changing drafting rules; do not add an
event-log dependency now and do not persist a new event log.

Use session evidence as follows:

- User requests, corrections, sequencing, attribution, and explicit status
  statements are canonical framing, just like the user's brain dump.
- Verified tool results may identify candidate commits, PRs, reviews, deploys, or
  tests to cross-check against collector evidence.
- Assistant summaries and claims are discovery hints only. They never prove work
  happened and must be corroborated by user statements or deterministic evidence.
- Conflicting session statements require the latest user correction, not the
  assistant's latest interpretation.
- Keep only compact extracted facts; never paste conversation excerpts into the
  stakeholder update.

If session search is unavailable, continue with the existing deterministic sources
and say that session framing was omitted. This is not equivalent to Git/GitHub
being unavailable and does not fail the evidence gate.

## Evidence gate

Before drafting, verify all of the following:

1. `source_status.git` and `source_status.github` are both `available`.
2. `github.review_collection_status`,
   `github.family_repository_lookup_status`,
   `github.linked_commit_lookup_status`, and
   `github.deployment_collection_status`,
   `github.deployment_pr_lookup_status`, and
   `github.graphite_batch_collection_status` are all `available`.
3. Every authored PR has an empty `collection_errors` list.
4. The window in the JSON exactly matches the window established above.

If any check fails, stop before drafting. Tell the user which source or
verification failed and ask whether to retry or proceed with a specifically
named omission. Never turn a failed source into an empty section.

For `unverified_update` or `context_only` entries, do not narrate them as work
unless canonical user framing explicitly supplies the missing involvement and
delta. Otherwise omit them and identify the omission when presenting the draft.

## Review and delivery boundary

Draft the update in the current conversation after the evidence gate passes. Do
not discover, read, create, or modify an Obsidian note or any other draft staging file.
Present the exact stakeholder-forwardable draft for owner approval. A request to
prepare or correct an EOD is not delivery approval; deliver only after the owner
explicitly approves the exact draft or explicitly orders immediate delivery of
that exact content. If the owner corrects it, reconcile the correction against
current evidence, present the revised exact draft, and await approval unless the
correction itself explicitly orders delivery.

After approval and final verification, send the exact approved update through the
typed `deliver_stakeholder_update` tool. This lane intentionally omits the visible
agent provenance banner so the owner can forward the message unchanged; sender,
time, size, and outcome remain in private audit metadata. Do not use `report_owner`,
a dispatcher, an inbound registry request, or the retired `relay-to-owner:` frame.
Only `deliver_stakeholder_update` evidence with `outcome=delivered` proves
completion. If delivery fails, preserve the exact draft and the bounded transport
error in durable task state; do not claim the EOD is complete. Do not send it to
Slack, email, GitHub, or any other stakeholder channel.

## Draft

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
- Include separately verified issue activity only with substantive user-involvement
  evidence or canonical user framing. An issue being touched or closed today
  does not prove it was the substantive work performed today.
- When exact bounded Graphite evidence is supplied, count each child PR once and
  cite both the child PRs and the merged batch group. Do not count the group as
  an additional authored PR.
- Reviews count only when the user submitted the review inside the window on
  another author's PR. Group them as Approved, Commented, or Changes-requested.
- Human and bot feedback are different. Never describe bot-only activity as
  human review feedback.
- Collapse related PR runs. One line should state a fact and its references.
- Use canonical GitHub PR links: `https://github.com/OWNER/REPO/pull/NUMBER`.
- Link every PR reference or none of them.
- Use ASCII only: no emoji, curly quotes, Unicode dashes, arrows, or ellipses.
- No first-person voice. No `Next items` unless the user supplied them.
- Aim below 1500 characters and never exceed Telegram's 4096-character limit.

## Final verification

Verify the exact draft once more:

- every claimed delta has user confirmation or reportable evidence;
- relevant same-day Pi session framing was reconciled when available, and no
  assistant-only session claim became a work claim;
- deployment work is present when deployment runs are present;
- workstream ordering and attribution match the user's checkpoint correction;
- no `unverified_update`, `context_only`, or committer-date-only event became a
  work claim without canonical user framing;
- every grouping follows verified repository data or canonical user framing, and
  every included issue or deployment item has substantive user-involvement evidence;
- every count is adjacent to exact references and agrees with those references;
- Graphite children and their batch group are reconciled without double-counting;
- the draft preserves every current user correction and requested emphasis;
- formatting is ASCII, terse, grammatical, and consistent with the owner's
  stakeholder-update preferences.

If any sentence cannot be traced to the user's words or the evidence JSON,
remove it or ask. Present the exact verified draft for approval. After approval,
re-verify that the payload is byte-for-byte the approved content, deliver it
through `deliver_stakeholder_update`, and require `outcome=delivered` before
reporting completion.
