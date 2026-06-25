---
name: review-pr
user-invocable: true
allowed-tools: Bash(gh:*), Bash(git:*), Bash(cursor-agent:*), Bash(agy:*), Bash(command:*), Bash(mkdir:*), Bash(cat:*), Bash(mktemp:*), Bash(rm:*), Bash(wc:*), Bash(date:*), Bash(basename:*), Bash(test:*), Bash(grep:*), Bash(find:*), Read, Write, Agent, Workflow, Skill
description: Cross-review a pull request by number or URL without checking it out. Runs a multi-model Workflow panel (2x Opus, Sonnet, a Composer cross-lab augment lane, 2 frontier external lanes that fall back GPT-5.5 -> Antigravity (agy) per Cursor usage limits, + inspectors) with per-finding verification, then starts a conversation so you can decide which findings (if any) to comment on the PR.
argument-hint: <pr-number | pr-url>
---

Cross-review a pull request that is **not** currently checked out. The PR number
or URL is passed in `$ARGUMENTS`. Use when you're reviewing someone else's PR and
want independent, multi-model analysis before commenting.

The **review engine** (panel, probes, prompts, the `review-panel` Workflow,
finding output) is shared with `/review-loop` and `/review-sweep` and lives in
`~/.claude/skills/review-core/SKILL.md`. This skill **scopes the diff to the PR
(without checking it out)** and, after the engine returns findings, **takes the
comment action**: a conversation where you decide which findings to post as a
draft PR review. It never modifies code.

Follow these steps precisely.

## 1. Parse the argument

`$ARGUMENTS` must be a PR number (e.g. `123`), a full GitHub URL
(`https://github.com/owner/repo/pull/123`), or an `owner/repo#123` shorthand. If
`$ARGUMENTS` is empty, use the PR associated with the current branch.

Normalize to `(owner, repo, number)` using `gh`:

```bash
pr_ref="$ARGUMENTS"

if [ -z "$pr_ref" ]; then
  # No argument — use the PR for the currently checked-out branch
  pr_json=$(gh pr view --json number,title,author,headRefName,baseRefName,url,body,headRepository,baseRepository,headRefOid,baseRefOid,state,isDraft,additions,deletions,changedFiles)
else
  case "$pr_ref" in
    https://github.com/*) ;;
    */*\#*)              ;;  # owner/repo#n
    [0-9]*)              ;;  # bare number (use current repo)
    *) echo "Unrecognized PR reference: $pr_ref"; exit 1 ;;
  esac
  pr_json=$(gh pr view "$pr_ref" --json number,title,author,headRefName,baseRefName,url,body,headRepository,baseRepository,headRefOid,baseRefOid,state,isDraft,additions,deletions,changedFiles)
fi
```

If `gh pr view` fails (e.g. no PR exists for the current branch), stop and tell
the user — they need to either pass a PR reference or check out a branch that has
an open PR.

Record the fields from the JSON: `number`, `title`, `author.login`, `headRefName`,
`baseRefName`, `url`, `body`, `headRefOid`, `baseRefOid`, `state`, `isDraft`,
`changedFiles`, `additions`, `deletions`, and the owner/name of the head and base
repos.

If the PR is closed, merged, or draft, warn the user and ask whether to continue.
Proceed only on explicit confirmation.

## 2. Prepare the workspace

```bash
repo_root=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
ts=$(date +%Y-%m-%d_%H-%M-%S)
safe_branch=$(echo "<headRefName>" | tr '/' '_')
out_dir="$repo_root/.tmp/reviews/pr-${pr_number}-${ts}-${safe_branch}"
mkdir -p "$out_dir"
```

Review artifacts always go under `.tmp/` (review output is local-only and
ephemeral). Most repos already gitignore `.tmp/`; if this one does not, ask the
user for permission before adding it. Do not silently modify `.gitignore`.

## 3. Fetch the diff

Fetch the PR diff from GitHub — do not check out the PR:

```bash
gh pr diff "<pr-ref>" > "$out_dir/diff.patch"
gh pr view "<pr-ref>" --json files --jq '.files[] | "\(.additions)\t\(.deletions)\t\(.path)"' > "$out_dir/files.txt"
wc -l "$out_dir/diff.patch"
```

Refuse to proceed on an empty diff. Warn on diffs larger than 5000 lines and ask
whether to continue — reviewer quality degrades on huge diffs.

Also save the PR metadata and the author's description:

```bash
echo "$pr_json" > "$out_dir/pr.json"
```

Strip bot-appended footers from the description before passing it to the engine:
cut everything from the first HTML-comment footer marker onward (CodeRabbit /
Codesmith badges, tracking links). Reviewers should see only the author-written
text.

## 4. Fetch the head ref for context

The reviewers need to read source files that the diff references, even if they're
not changed by the PR. Fetch the head ref into the local repo without switching
branches:

```bash
head_owner_repo="<owner>/<repo>"   # from headRepository.nameWithOwner
head_sha="<headRefOid>"

# If the PR is from a fork, add the fork as a remote
git remote add pr-review-head "https://github.com/${head_owner_repo}.git" 2>/dev/null || true
git fetch pr-review-head "$head_sha"

# Now reviewers can resolve paths at that commit via `git show $head_sha:<path>`
```

If the PR is on the same repo, skip the remote-add step; the fetch is enough.

## 5. Load project context

```bash
find "$repo_root" -maxdepth 3 \( -name "CLAUDE.md" -o -name "AGENTS.md" \) \
  -not -path "*/node_modules/*" -not -path "*/target/*"
```

Keep only the paths — they become `docsPaths` for the engine.

## 6. Run the review engine

Run the shared engine in `~/.claude/skills/review-core/SKILL.md` (steps 1–7:
probes → reviewer prompts → inspector prompts → lanes → the `review-panel`
Workflow → after-workflow handling → print findings). Pass the contract inputs:

| Contract input          | Value for review-pr                                                     |
| ----------------------- | ---------------------------------------------------------------------- |
| `out_dir`, `{DIFF_PATH}`, `{FILES_PATH}`, `{REPO_ROOT}` | from steps 2–3 (`$out_dir/diff.patch`, `$out_dir/files.txt`) |
| `{PROJECT_DOCS_PATHS}`  | the docs paths from step 5                                              |
| `{PR_DESCRIPTION}`      | the author's description (bot footers stripped) from step 3            |
| `{SOURCE_ACCESS}`       | `The change was authored against commit <head_sha>. Read source files via 'git show <head_sha>:<path>' — the working tree does not match the change under review.` |
| `{SCOPE_NOTE}`          | `The diff is scoped to exactly the changes on this PR.`                |
| `{INSPECTOR_ARG}`       | the PR reference (`<pr-ref>`)                                          |
| `{REPORT_HEADER}`       | `# Review — PR #<n>: <title>\n**Author:** <author>\n**URL:** <url>\n**Branches:** <head> -> <base>\n**Head SHA:** <head_sha>\n**Files changed:** <N> (+<additions>/-<deletions>)` |
| `{TERMINAL_HEADER}`     | `PR #<n> — <title>\n<author>  ·  <head>..<base>  ·  <N> files, +<add>/-<del> lines\n<url>` |
| `{SYNTHESIS_EXTRA}`     | `CRITICAL ADAPTATIONS FOR THIS REPORT: (1) No AI references anywhere — no agent attribution, no 'Found by' field, no mention of models, reviewers, lanes, or cross-review. The report must read like a single human senior engineer wrote it. (2) Frame the Overall assessment as advice to the REVIEWER reading this report, not to the PR author — e.g. 'This PR looks ready to merge pending X' or 'I'd push back on Y before approving.'` |
| `{INCLUDE_ATTRIBUTION}` | `false`                                                                |

`{INCLUDE_ATTRIBUTION}` being `false` makes the engine strip the `Found by` field
from `review.md` and drop the lane bracket from the terminal output — the on-disk
`findings.json` keeps `found_by` for local audit only. With `{SOURCE_ACCESS}`
threaded into the workflow, the in-panel verifier and synthesizer read source at
the head SHA via `git show`, not the (mismatched) working tree.

The engine writes `$out_dir/review.md` and `$out_dir/findings.json` and prints the
terminal summary. Then continue to the conversation below — **do not** triage or
fix anything; this skill only comments.

## 7. Enter the review conversation

After the engine prints, **stay in the session**. Do not end the turn with a
summary — the user wants to have a conversation about the findings.

Say something like:

> Review saved to `<path>`. Let me know which findings you want to dig into, and
> when you're ready I can post comments on the PR.

Then wait. For any follow-up question:

- **"tell me more about #N"** — read the full finding from `review.md` and explain
  it conversationally. Read the relevant source via `git show $head_sha:<path>` to
  confirm the claim yourself.
- **"is finding #N actually valid?"** — verify by reading the code at the head
  SHA. Report your independent read.
- **"draft a comment for #N"** — write a PR-comment-style message (concise,
  constructive, cite file/line, propose fix). Show it to the user and wait for
  approval.
- **"post"** or **"post as draft"** — create a **pending (draft) GitHub review**
  with inline comments. See "Posting a draft review" below. The user will inspect,
  edit, and submit from the GitHub UI — no per-comment text approval is needed
  here.
- **"post #N, #M"** — same as "post" but only include the listed findings.
- **"I'm done"** — summarize what was posted (if anything) and end the turn.

### Posting a draft review

When the user says "post" or "post as draft", create a **PENDING** GitHub review
with each finding as an inline comment on its file/line. This lets the user go to
the GitHub UI, inspect each comment, edit or delete as needed, and click "Submit
review" themselves.

**Step 1 — Build the comments JSON.** For each finding, create an inline comment
object. Use the finding's file path and line number from the review.

**Comment tone rules:**
- Write like a human colleague leaving a quick review comment. Short, direct,
  conversational.
- No numbered prefixes like `#1`, `**#2 (HIGH)**`, etc. Just say what the issue
  is.
- No em dashes. Use commas, periods, or "because" instead.
- **Start each comment with a lowercase severity prefix** that signals how
  important the finding is: `critical:`, `should fix:`, `minor:`, or `nit:`. This
  replaces bold labels and numbered prefixes. The prefix is short and natural,
  like a colleague would write.
- No bullet-point lists inside a single comment unless genuinely needed. Prefer
  short paragraphs.
- Keep each comment to 2-4 sentences. Say what's wrong, why it matters, and what
  to do about it.

**Leave the review `body` empty.** Do NOT post the overall assessment to the draft
— GitHub would attach it as the review summary, and the user wants to write/paste
that themselves at submit time. You'll print the assessment in the conversation in
Step 2 instead.

```bash
# Build the review payload as a JSON file.
# "body" is intentionally empty — the overall assessment is displayed in
# the conversation (Step 2), not posted to the draft.
review_json=$(mktemp -t pr-review.XXXXXX.json)
cat > "$review_json" <<'ENDJSON'
{
  "commit_id": "<head_sha>",
  "body": "",
  "comments": [
    {
      "path": "<file relative to repo root>",
      "line": <line number in NEW file>,
      "side": "RIGHT",
      "body": "<finding description + suggested fix>"
    }
  ]
}
ENDJSON
```

For findings that span a range, use `start_line` + `line`:
```json
{ "path": "src/foo.rs", "start_line": 10, "line": 15, "side": "RIGHT", "body": "..." }
```

**Step 2 — Post via the Reviews API.**

```bash
gh api repos/<owner>/<repo>/pulls/<pr-number>/reviews \
  --input "$review_json"
rm "$review_json"
```

**CRITICAL: Omit the `event` field entirely to create a PENDING review.** The
GitHub API does NOT accept `"event": "PENDING"` — it returns a 422. Omitting
`event` is what makes the review a draft.

This creates a draft review visible only to you (the reviewer) until submitted.
Tell the user the draft is up, then **print the overall assessment in the
conversation as a fenced copy-paste block** so they can paste it into the review
summary box when they submit from the GitHub UI:

> Draft review created with N inline comments. The overall summary is not part of
> the draft — paste this into the review summary box when you submit:
>
> ```
> <overall assessment — 2-3 sentences>
> ```
>
> Go to <pr-url> to inspect, edit, or delete comments, then click "Submit
> review."

**CRITICAL: `line` must be a line present in the diff hunk, not any arbitrary line
in the file.** To find the right line number:
- Read the diff (`$out_dir/diff.patch`) and identify the `+`-side line number
  within the changed hunk that best matches the finding
- If the finding points to a line NOT in the diff, use the nearest changed line in
  the same file, or fall back to creating a top-level review comment instead of an
  inline one

**Step 3 — Handle findings without diff lines.** Strongly prefer inline comments
over top-level body text. If a finding references unchanged code, look for a
**related** changed line in the diff where the comment makes sense contextually.
For example, if a finding is about an interaction between existing code and newly
introduced code (e.g., "the existing reconciler doesn't account for the new
compaction policy"), place the comment on the new code that introduces the
interaction, not on the untouched code. Only when a finding has genuinely no
related changed code anywhere in the diff (e.g., a missing file, a documentation
gap, a broad architectural concern), fold it into the copy-paste assessment block
you print in the conversation (Step 2) rather than the posted `body` — the draft
`body` stays empty.

## Hard rules

1. Never check out the PR branch. Work off `gh pr diff` and `git show` at the head
   SHA.
2. `review.md` has no per-finding agent attribution (`{INCLUDE_ATTRIBUTION}` is
   false). Attribution stays in `findings.json` only.
3. For draft reviews ("post" / "post as draft"), per-comment approval is NOT
   required — the GitHub UI is the approval mechanism. For immediate submissions
   (non-draft), never post without explicit user approval of the exact text.
4. Always use `--body-file` (or heredoc to a tempfile) for comment bodies.
5. Stay in the session after the engine prints — this command is a conversation,
   not a one-shot.
6. If the PR is closed/merged/draft, ask before proceeding.
7. **Posted reviews must read like a human wrote them.** No AI references (models,
   agents, Claude, GPT, Gemini). No numbered finding prefixes (`#1`, `**#2
   (HIGH)**`). No em dashes. No bold severity labels. Use lowercase severity
   prefixes (`critical:`, `should fix:`, `minor:`, `nit:`). Write short, direct
   comments like a colleague would. The `findings.json` and `review.md` on disk
   can use structured formatting (they're local), but anything posted to GitHub
   must be conversational and concise.
8. **Maximize inline comments; the draft `body` stays empty.** Never post the
   overall assessment to the draft review — leave `body` empty and print the 2-3
   sentence assessment in the conversation as a copy-paste block for the user to
   paste at submit time. Every finding should be an inline comment on a diff line.
   When a finding references unchanged code, place the comment on the nearest
   related changed line.
9. The review runs as a single `Workflow` invocation (review-core) — never
   hand-roll the fan-out with individual Agent calls. External CLIs run read-only
   (review-core step 4 / hard rules): cursor-agent always `--mode plan`, never
   `-f`/`--yolo`, and `--workspace` spelled out (`-w` is `--worktree`); agy always
   `--sandbox` and NEVER `--dangerously-skip-permissions`.
