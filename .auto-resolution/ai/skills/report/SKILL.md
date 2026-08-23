---
name: report
description: Format and directly deliver provenance-bearing Telegram reports for every owner-facing status, finding, handoff, question, correction, sign-off, or escalation; keep them phone-readable, but do not use for stakeholder-forwardable EOD/EOW content.
---

# Report

The owner reads these on a phone, usually while doing something else. A report
is scanned, not studied: they are looking for what needs them, and everything
else is noise competing with it. A dense paragraph of prose buries the one
sentence that mattered, and it is the second most common failure here. The
first is a report that never arrives at all.

**This applies to EVERY owner-facing message, not only to things called
reports.** A `pi-bridge respond` reply, an acknowledgement, a status note, a
bug report, a question, a correction — each lands in the same chat, on the same
phone, and gets the same structure: bold section headers with counts, one item
per line, the identifier first, a blank line between sections, and every
external reference carrying its corresponding verified link. This is broader
than identifiers: PRs, issues, external docs, and other outside references are
all linked. Prose paragraphs are not a lighter-weight register for small
messages; they are the failure mode this skill exists to prevent, and a short
unstructured note is simply a small wall of prose.

The observed failure is precise and worth naming: lanes read this skill as
advice for the daily update, format that one message well, and then write
everything else as paragraphs. If the owner will read it, it is covered here.

## Deliver it

An owner report is outbound transport, never an inbound agent message. Do not
send it through a dispatcher and do not use the retired `relay-to-owner:` frame:
that extra inbox hop could inject an agent report into Pi under an authenticated
owner envelope.

Native Pi sessions use the typed tool:

```
report_owner { text: "<report>" }
```

Claude Code, Cursor, and other CLI lanes call the same verified Telegram sender
directly and identify themselves:

```
printf '%s' '<report>' | pi-bridge owner-report --sender <stable-agent-id>
```

The delivered Telegram message begins with an immutable provenance line such as
`Agent report · claude-review-duty · direct via Piece of Pi`. Report content
cannot impersonate an owner command, and it never enters an agent inbox.

A final EOD or team update explicitly prepared for the owner to forward unchanged
to stakeholders is not an agent report. Native Pi sessions use the separate typed
lane:

```
deliver_stakeholder_update { text: "<exact verified update>" }
```

CLI lanes use:

```
printf '%s' '<exact verified update>' | pi-bridge stakeholder-update --sender <stable-agent-id>
```

That visible Telegram message contains the exact update with no agent banner.
Sender, timestamp, size, and outcome remain in private audit metadata. Never use
this lane for status, findings, handoffs, questions, or anything addressed to the
owner as owner; those remain ordinary provenance-bearing reports.

**Only typed delivery evidence counts.** `report_owner` must return
`outcome=delivered`; `pi-bridge owner-report` must exit zero with JSON containing
`"outcome":"delivered"`; stakeholder delivery must likewise return
`outcome=delivered` (or CLI JSON with `"mode":"stakeholder_update"`). A queued
bridge message is not delivery, and there is no queue or dispatcher receipt to
poll for the direct path. On failure, retain
the report and error in durable task state before the session ends.

## What renders

`owner-telegram.ts` renders a markdown SUBSET into Telegram HTML. Only these
four constructs exist:

| Write | Renders as |
| --- | --- |
| `**text**` | bold |
| `` `text` `` | inline code |
| `[label](https://url)` | tapped link |
| triple-backtick fenced block | code block |

Everything else is literal text. There are **no** headings, italics, tables,
blockquotes, or bullet glyphs — a `#` renders as a `#`, and a leading `-` is
just a hyphen, which is fine and reads as a list. Do not reach for markup the
renderer does not have; it arrives as punctuation and looks broken.

Messages chunk at 4000 characters on rendered lines. A report needing several
chunks is a report that should have been shorter.

## Shape

Lead with what needs the owner. Sort by what they must do, never
chronologically and never by which agent produced it.

```
**Needs you** (2)

1. issuance 237 restack - unowned. 29 rustc errors inherited from 236.
   Blocked: your checkout is on `feat/freeze-hold-guard`, ahead 2 behind 2.
2. liquidity 1091 - `ci.yaml` pins nix 2.31.2, action ships 2.31.5.
   Lands on a dependabot branch, needs an owner.

**Ready to submit** (1)

- [liquidity 1112](https://app.graphite.dev/github/pr/ST0x-Technology/st0x.liquidity/1112) -
  review staged, invisible until you submit.

**Done, no action** (3)
- 1004 hooks, 1032/1033 rate limits, 278 already covered.
```

Rules that make it scannable:

- **Count every section.** `Needs you (2)` tells them the size before reading.
- **One item per line.** A line that wraps three times on a phone is a
  paragraph wearing a list's clothes.
- **Lead each item with its identifier**, so the eye lands on `issuance 237`
  and not on the fourth clause of a sentence.
- **Link every external reference**, not only PR and issue identifiers. A tap
  beats a search. Use Graphite PR links for stacked orgs, GitHub PR/issue links
  for non-Graphite repos, Linear's returned `url` for Linear issues, and a
  verified destination for external docs or other references. See below.
- **Blank line between sections.** It is the only visual separation available.
- Put the diagnosis on the item, not in a trailing narrative paragraph.
- Say what is BLOCKED and on what. An unowned item with no blocker reads as
  something the owner must do now, which may be false.

## Links that carry a route

A link is the only interactive element the renderer has, so it is the whole
budget for getting the owner from the report to the thing. Spend it on the
destination that answers the question the item raises, and build it from
identifiers you already hold — never guess a URL.

| Destination | Shape |
| --- | --- |
| GitHub PR | `https://github.com/<owner>/<repo>/pull/<number>` |
| GitHub issue | `https://github.com/<owner>/<repo>/issues/<number>` |
| Graphite PR | `https://app.graphite.dev/github/pr/<owner>/<repo>/<number>` |
| Linear issue | the `url` field Linear returned for that issue |
| External doc/reference | its verified canonical or source-provided URL |

**Every external reference must carry its corresponding verified link.** This
includes PRs, issues, Linear issues, external docs, specifications, dashboards,
and any other outside destination mentioned in the report. If a verified link
is unavailable, omit the external reference or state that its link is
unverified without inventing one.

**Linear URLs are never constructed.** They are workspace-scoped and the API
returns the exact one on the issue; building a URL from an identifier like
`RAI-1045` produces a plausible link that does not resolve. Use only Linear's
returned `url`; if it is not to hand, do not guess or present the issue as a
linked external reference.

**Prefer Graphite over GitHub when the repo stacks**, which is the
`~/code/st0x/*` and `~/code/rainlanguage/*` family. A GitHub link opens one PR
in isolation; the Graphite link opens it inside its stack, which is the context
that decides whether it can merge. For a repo that does not stack, GitHub is
the right destination and Graphite has nothing to show.

One caveat that looks like a bug and is not: inside a Pi pane, Graphite
markdown links are deliberately flattened to their bare URL so the terminal
shows something copyable. That rewrite is display-only and does not touch the
relayed report, so keep writing the markdown link form.

## What to leave out

- Your process. What you tried, in what order, and how long it took is your
  concern, not theirs.
- Anything already resolved that needs no decision, beyond a single closing
  line naming the count.
- Restating the request back to them.
- Credentials, prompts, raw logs, and full diffs. Reference by
  `file:line`, PR number, or request id.
- Reassurance. `Nothing was pushed, posted, or submitted` earns its place
  because it bounds risk; `Hope this helps` does not.

## Sign-off reports

A session ending has one extra duty: everything it knows dies with it. Name
each open item, its current diagnosis, and who or what it is blocked on — an
item that only says "unowned" forces the owner to rediscover what you already
knew. Then verify delivery before tearing down, because a sign-off that failed
to send is indistinguishable from a session that had nothing to say.
