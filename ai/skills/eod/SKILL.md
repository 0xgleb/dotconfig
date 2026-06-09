---
name: eod
description: Write today's end-of-day update in the Obsidian vault, sourcing from Linear and GitHub. Optional brain-dump context overrides everything.
user-invocable: true
allowed-tools:
  - "Bash(linear *)"
  - "Bash(gh *)"
  - "Bash(gt *)"
  - "Bash(ls *)"
  - "Bash(date *)"
  - "Read"
  - "Edit"
  - "Write"
  - "AskUserQuestion"
---

# EOD Skill

## Invocation

```
/eod                 # gather context yourself, write the note
/eod <brain dump>    # user-provided context is the source of truth
```

## Hard rules

- **Scope: the st0x / Rain family of orgs** — ST0x-Technology, rainlanguage,
  and sibling family orgs. NEVER data-cartel: that's the user's own org and
  belongs in a separate update, not this one.
- **Tools: `linear`, `gh`, `gt` only.** No `git`, no `cat`, no ad-hoc
  scripts. Read files with `Read`.
- **Never fabricate.** No "Next items" unless the user wrote them. No
  prose pulled from places the user didn't point you at. Filing a
  ticket today does not mean it's tomorrow's plan.
- **Never assign the user tasks.** You report what happened. They
  decide what's next.
- **If unclear, stop and ask** while the user is in the chat. If they
  stepped away, leave the section blank rather than guess.
- **References serve content, not the reverse.** Every bullet should
  carry a verifiable identifier (RAI-XXX, PR N, repo) but the bullet
  itself stays terse. Don't pad descriptions with details you scraped.

## Workflow

1. **Find the file.** Today's note lives at
   `/Users/0xgleb/Library/Mobile Documents/iCloud~md~obsidian/Documents/repos/notes/`
   under `YY.MM.DD@HH.MM-eod.md`. Match by today's date prefix
   (`date +%y.%m.%d`). If none exists, ask the user — they create it
   in Obsidian. If multiple, ask which.

2. **Read recent EODs.** `ls` the notes dir, `Read` the last 2–3
   `*-eod.md` files. Match their format exactly — section order,
   dividers, bullet style, dash convention, how repos are abbreviated.
   The template in the empty file is a skeleton; recent notes show
   the actual house style.

3. **Preserve user edits.** Read the target file. If anything beyond
   the empty `<!-- ... -->` template comments is present, the user
   wrote it — keep it verbatim. Use `Edit`, not `Write`, when filling
   in around their text.

   **Pre-sketched-TLDR format.** The user often opens Obsidian and
   leaves their brain dump embedded INSIDE the section comment, like:

   ```markdown
   ## Today

   <!--
   note, this is the tl;dr from the user. replace this comment with a
   more structured and cross-referenced note with links to PRs, issues,
   etc.

   ---

   TLDR:

   <user's actual brain dump text here>

   -->
   ```

   Treat the text after `TLDR:` inside the comment as the brain dump
   (same canonical role as a `/eod <brain dump>` argument). When
   filling in, REPLACE the entire `<!-- ... -->` block with the
   structured expansion of that TLDR. Do not leave the original
   comment intact. The user may also drop "note to ai agent: ..."
   instructions inside the comment — treat those as binding
   directives for this run.

4. **Source of truth.**
   - **With brain dump (CLI arg or embedded TLDR):** the user's text is
     canonical for framing and emphasis — don't contradict or embellish it.
     But a brain dump is a TLDR, not a complete inventory: still run the
     queries below and reconcile. A throwaway line like "addressing feedback,
     merging" routinely hides work across several repos — never let the dump's
     brevity become an omission. Cross-reference Linear/GitHub so readers can
     drill down (link RAI tickets and PR numbers where they fit).
   - **Without brain dump:** gather from Linear and GitHub (queries below).
     If the data is sparse, ask before drafting — don't invent a day.

   Either way, gather by **activity** across the family orgs: a PR you pushed
   commits to today (addressing review, iterating a draft) is today's work even
   if it was opened earlier — filter by `--updated`, not just
   `created`/`merged-at`, and check every repo, not just the obvious one.

5. **Draft.** Match the format of the last few EODs. Common shape:
   - `# Daily Update:  YYYY-MM-DD`
   - Status paragraph (one to three sentences)
   - A one-line **stats summary** — be granular. "N PRs opened" alone is
     near-meaningless; the group chat wants the breakdown of where those
     PRs landed. Report each of the following counts, dropping any that
     are zero: **PRs opened, PRs submitted for review (reviewers
     assigned), PRs still draft, PRs merged, PRs reviewed, issues
     created, issues closed**. e.g.
     `11 PRs opened - 3 submitted for review - 8 still draft - 2 merged - 5 reviewed - 7 issues created - 1 closed`.
     Opened-but-still-draft vs submitted-for-review vs merged is the
     signal — never collapse it back to a single "opened" number. The
     detail follows below.
   - `## What Was Done` with topic-grouped subsections or a flat
     bullet list, whichever the recent notes use
   - `### Reviews` if any PRs were reviewed
   - **No `## Next items` unless the user wrote them.**

   Drop any section that has no data. Empty sections are bloat.

6. **Optional: file follow-up tickets.** Only if the brain dump
   explicitly describes something that warrants a new Linear issue,
   you may create it with `linear issue create` and reference the new
   ticket from the EOD. Don't proactively create tickets from
   inferred work.

## Data queries

Cache `viewer.id` once per run:

```bash
linear api 'query { viewer { id displayName email } }'
```

Substitute today as `YYYY-MM-DDT00:00:00Z`.

**Issues I created today:**

```bash
linear api 'query($u: ID!, $a: DateTimeOrDuration!) {
  issues(filter: { creator: { id: { eq: $u } }, createdAt: { gte: $a } }, first: 100) {
    nodes { identifier title url state { name } assignee { displayName } }
  }
}' --variable u=<id> --variable a=<iso>
```

**My comments today:**

```bash
linear api 'query($u: ID!, $a: DateTimeOrDuration!) {
  comments(filter: { user: { id: { eq: $u } }, createdAt: { gte: $a } }, first: 100) {
    nodes { body issue { identifier title url } }
  }
}' --variable u=<id> --variable a=<iso>
```

**PRs I reviewed today** (NOISY — `--reviewed-by` + `--updated` returns every PR
you have *ever* reviewed that happened to be updated today, including your own
PRs and stale reviews bumped by someone else's commit). Treat it as a candidate
list; verify each one you cite is a review you actually submitted today:

```bash
gh search prs --reviewed-by=@me --owner=ST0x-Technology,rainlanguage \
  --updated=YYYY-MM-DD --json number,title,repository,url --limit 100
# verify a candidate: did YOU submit a review today?
gh pr view <N> --repo <org>/<repo> --json reviews \
  --jq '.reviews[] | select(.author.login=="<your-login>") | {state, submittedAt}'
```

**PRs I authored that moved today** — filter by `--updated` (catches PRs you
*iterated on* today even if opened earlier, e.g. pushing fixes after review) and
scope to the family orgs. There is NO `mergedAt` field on `gh search prs` —
requesting it errors:

```bash
gh search prs --author=@me --owner=ST0x-Technology,rainlanguage \
  --updated=YYYY-MM-DD --json number,title,repository,url,state,isDraft --limit 100
```

**Day stats (counts for the summary line).** On `gh search prs`, `--jq length`
returns the count directly. `--created` / `--closed` / `--merged-at` take a
`YYYY-MM-DD` (or a `START..END` range). WATCH OUT: the bare `--merged` flag is a
BOOLEAN, not a date — passing a date errors; use `--merged-at`. `linear api`
does NOT support `--jq` — count Linear results by fetching `identifier`s and
counting the nodes.

```bash
# scope every query to the family orgs (add siblings as needed; never data-cartel)
# PRs opened today
gh search prs --author=@me --owner=ST0x-Technology,rainlanguage --created=YYYY-MM-DD --json number --jq length
# PRs merged today
gh search prs --author=@me --owner=ST0x-Technology,rainlanguage --merged-at=YYYY-MM-DD --json number --jq length
# PRs reviewed today (rough — see the review-noise warning above; verify before citing)
gh search prs --reviewed-by=@me --owner=ST0x-Technology,rainlanguage --updated=YYYY-MM-DD --json number --jq length
```

**Submitted-for-review vs still-draft split.** `gh search prs` does NOT
expose draft status or review requests, so split the opened-today PRs
per repo with `gh pr list`. A PR counts as "submitted for review" when
`isDraft` is false AND `reviewRequests` is non-empty; "still draft" when
`isDraft` is true. Filter the rows to `createdAt` = today.

```bash
gh pr list --repo ST0x-Technology/<repo> --author @me --state open \
  --json number,isDraft,reviewRequests,createdAt --limit 50
```

Run once per repo touched today (check the "PRs I authored that moved
today" output for which repos to query). Reviewers assigned today on an
older PR also count as submitted-for-review, but that's not cheaply
queryable — the opened-today split is the reliable signal; note any
known draft-to-ready flips of older PRs in prose rather than the count.

```bash
# Linear issues you closed (completed) today
linear api 'query($u: ID!, $a: DateTimeOrDuration!) {
  issues(filter: { assignee: { id: { eq: $u } }, completedAt: { gte: $a } }, first: 100) {
    nodes { identifier }
  }
}' --variable u=<id> --variable a=<iso>
```

(Issues created today: use the "Issues I created today" query above.)

`gt log short` in a worktree gives the current stack shape if you need
to describe an open stack the user mentioned.

## Style

- **The EOD ships as a Telegram message to a ~10-person group chat.**
  Treat it as a standup post, not a journal entry. Telegram premium
  message limit is 4096 chars — aim well under that, and the user
  will still call out bloat over ~1500 chars.
- **One line per thing.** Every bullet is a fact + identifier (RAI
  tag, PR number, repo). No prose paragraphs explaining what a PR
  does — readers click through if they want detail.
- **Prose must stand on its own for an outsider.** PR titles in
  backticks can stay technical (readers click through), but any prose
  YOU write -- the summary sentence, a section header, the line
  grouping a set of PRs -- must make sense to someone in the ~10-person
  chat who was NOT managing this line of work. No insider shorthand:
  "Dep prep ahead of the stack" is meaningless to them; "two library
  upgrades the refactor depends on" is not. If you can't restate a
  grouping in plain words, the reader can't decode it either -- so
  don't write it that way.
- **Collapse runs.** Five PRs in one repo with similar titles
  collapse to `repo PRs A, B, C, D, E`. Don't list each title
  separately unless the titles are doing real work.
- Backtick PR/commit titles. When you link a PR, link to **Graphite**,
  never the GitHub `github.com/.../pull/N` URL — the stack is reviewed and
  merged through Graphite. Format:
  `[PR N](https://app.graphite.com/github/pr/<org>/<repo>/<N>)`, e.g.
  `[PR 729](https://app.graphite.com/github/pr/ST0x-Technology/st0x.liquidity/729)`.
  (Bare `PR N` is fine too if a section reads better unlinked; just never
  emit a GitHub PR URL.)
- Repo names abbreviated (`st0x.issuance`, `raindex`), not full
  `org/name` paths, unless prior EODs use the long form.
- ISO dates only.
- No emoji. No "I"/"we" — drop the subject.
- Strip redundant info: don't repeat the RAI tag in a PR title if the
  bullet already has the PR number tied to that issue elsewhere.
- Each section earns its place. If the day's work has no Linear
  output, drop the Linear section. If no reviews, drop Reviews.
- Reviews are a stat, not prose. Cite the count (and which repos); never
  describe what someone else's reviewed PR does — the note is what the user
  built, not the work they happened to review.
- Link every PR reference, or none — never link the first and leave the rest
  bare. Pick one convention and apply it uniformly.
- Don't borrow a tool's reserved words for loose meaning: "initiative",
  "project", "epic", "cycle" are Linear primitives; "stack" is Graphite. And
  don't imply newness ("N new X") unless the user said it's new.
- It's a clean note for stakeholders, not a transcript of the chat: never
  paste the user's feedback or your own corrections into the note (e.g. "none
  of it new", "not just what merged"), and read every sentence for sense and
  grammar before finishing.
