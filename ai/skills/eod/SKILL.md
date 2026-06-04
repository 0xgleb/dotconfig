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
   - **With brain dump (CLI arg or embedded TLDR):** user's text is
     canonical. Cross-reference to Linear/GitHub so stakeholders can
     drill down (link RAI tickets and PR numbers where they fit),
     but don't contradict or embellish the dump.
   - **Without brain dump:** gather from Linear and GitHub (queries
     below). If the data is sparse, ask before drafting — don't
     invent a day.

5. **Draft.** Match the format of the last few EODs. Common shape:
   - `# Daily Update:  YYYY-MM-DD`
   - Status paragraph (one to three sentences)
   - A one-line **stats summary** (counts only, drop any zero): e.g.
     `3 PRs opened · 1 merged · 5 reviewed · 2 issues created · 1 closed`.
     At-a-glance numbers for the group chat; the detail follows below.
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

**PRs I reviewed today:**

```bash
gh search prs --reviewed-by=@me --updated=YYYY-MM-DD \
  --json number,title,repository,url --limit 50
```

**PRs I authored that moved today:**

```bash
gh search prs --author=@me --updated=YYYY-MM-DD \
  --json number,title,repository,url,state,mergedAt --limit 50
```

**Day stats (counts for the summary line).** `--jq length` returns the
count directly. `--merged` / `--created` / `--closed` take a single
`YYYY-MM-DD`, not a range.

```bash
# PRs opened today
gh search prs --author=@me --created=YYYY-MM-DD --json number --jq length
# PRs merged today
gh search prs --author=@me --merged=YYYY-MM-DD --json number --jq length
# PRs reviewed today (rough — PRs you reviewed that moved today)
gh search prs --reviewed-by=@me --updated=YYYY-MM-DD --json number --jq length
```

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
