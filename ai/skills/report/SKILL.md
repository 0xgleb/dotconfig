---
name: report
description: Write and deliver an agent report to the owner on Telegram. Use whenever a session reports status, hands off, signs off, escalates a decision, or relays findings to the owner - and whenever a report needs to be readable on a phone rather than a wall of prose. Covers the relay-to-owner send shape, delivery verification, the renderable markup subset, and the structure that survives a small screen.
---

# Report

The owner reads these on a phone, usually while doing something else. A report
is scanned, not studied: they are looking for what needs them, and everything
else is noise competing with it. A dense paragraph of prose buries the one
sentence that mattered, and it is the second most common failure here. The
first is a report that never arrives at all.

## Deliver it

Reports reach the owner through the dispatcher, never by replying on the
originating channel yourself:

```
printf '%s' 'relay-to-owner: <report>' | pi-bridge send --agent <dispatcher-id> --dedupe <key>
```

**The `relay-to-owner:` prefix is what makes it a relay.** A send whose text
matches no known frame is treated as routable payload and delegated to a
project queue instead — the report is filed against some project, and if that
project is one nothing drains it simply expires an hour later. Plain-text
reports do not reach the owner.

**A `queued` return is not delivery.** The send always returns `queued`. Verify
before trusting it, and always before a session tears down:

```
nu -c "open ~/.local/state/pi/remote-control/bridge.sqlite | query db \"SELECT status, response FROM bridge_messages WHERE dedupe_key = '<key>'\" | to json"
```

`Relayed to owner on Telegram.` means it landed. `Routed to <project> (request
<id>)` means it did not — it went to a queue. A session that signs off without
checking takes its context with it, and nobody can re-send the report once it
is gone.

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
- **Link PRs and issues** rather than naming bare numbers. A tap beats a
  search. See the shapes below.
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

**Linear URLs are never constructed.** They are workspace-scoped and the API
returns the exact one on the issue; building a URL from an identifier like
`RAI-1045` produces a plausible link that does not resolve. If the `url` field
is not to hand, write the bare identifier rather than a guess.

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
