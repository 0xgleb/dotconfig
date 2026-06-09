---
allowed-tools: Bash(gh:*), Bash(git:*), Bash(codex:*), Bash(mkdir:*), Bash(wc:*), Bash(date:*), Bash(basename:*), Bash(test:*), Bash(grep:*), Read, Write, Agent, Workflow, Skill
description: Cross-review a pull request by number or URL without checking it out. Runs a multi-model Workflow panel (2x Fable, Sonnet, 2x Codex gpt-5.5 + inspectors) with per-finding verification, then starts a conversation so you can decide which findings (if any) to comment on the PR.
argument-hint: <pr-number | pr-url>
---

Cross-review a pull request that is **not** currently checked out. The PR
number or URL is passed in `$ARGUMENTS`. Use when you're reviewing someone
else's PR and want independent, multi-model analysis before commenting.

Follow these steps precisely.

## 1. Parse the argument

`$ARGUMENTS` must be a PR number (e.g. `123`), a full GitHub URL
(`https://github.com/owner/repo/pull/123`), or an `owner/repo#123` shorthand.
If `$ARGUMENTS` is empty, use the PR associated with the current branch.

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

If `gh pr view` fails (e.g. no PR exists for the current branch), stop and
tell the user — they need to either pass a PR reference or check out a branch
that has an open PR.

Record the fields from the JSON: `number`, `title`, `author.login`,
`headRefName`, `baseRefName`, `url`, `body`, `headRefOid`, `baseRefOid`,
`state`, `isDraft`, `changedFiles`, `additions`, `deletions`, and the owner/name
of the head and base repos.

If the PR is closed, merged, or draft, warn the user and ask whether to
continue. Proceed only on explicit confirmation.

## 2. Prepare the workspace

```bash
repo_root=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
ts=$(date +%Y-%m-%d_%H-%M-%S)
safe_branch=$(echo "<headRefName>" | tr '/' '_')
out_dir="$repo_root/claude-local-ctx/reviews/pr-${pr_number}-${ts}-${safe_branch}"
mkdir -p "$out_dir"
```

If `claude-local-ctx/` is not in `.gitignore`, ask the user for permission to
add it. Do not silently modify `.gitignore`.

## 3. Fetch the diff

Fetch the PR diff from GitHub — do not check out the PR:

```bash
gh pr diff "<pr-ref>" > "$out_dir/diff.patch"
gh pr view "<pr-ref>" --json files --jq '.files[] | "\(.additions)\t\(.deletions)\t\(.path)"' > "$out_dir/files.txt"
wc -l "$out_dir/diff.patch"
```

Refuse to proceed on an empty diff. Warn on diffs larger than 5000 lines and
ask whether to continue — reviewer quality degrades on huge diffs.

Also save the PR metadata and the author's description:

```bash
echo "$pr_json" > "$out_dir/pr.json"
```

## 4. Fetch the head ref for context

The reviewers need to read source files that the diff references, even if
they're not changed by the PR. Fetch the head ref into the local repo
without switching branches:

```bash
head_owner_repo="<owner>/<repo>"   # from headRepository.nameWithOwner
head_sha="<headRefOid>"

# If the PR is from a fork, add the fork as a remote
git remote add pr-review-head "https://github.com/${head_owner_repo}.git" 2>/dev/null || true
git fetch pr-review-head "$head_sha"

# Now reviewers can resolve paths at that commit via `git show $head_sha:<path>`
```

If the PR is on the same repo, skip the remote-add step; the fetch is enough.

In the reviewer prompt, tell each reviewer they can read any file at
`<head_sha>:<path>` via `git show` — they should not assume the working tree
matches the PR.

## 5. Load project context

```bash
find "$repo_root" -maxdepth 3 \( -name "CLAUDE.md" -o -name "AGENTS.md" \) \
  -not -path "*/node_modules/*" -not -path "*/target/*"
```

Keep only the paths. Reviewers will read them themselves.

## 6. Build the reviewer prompts

Build per-reviewer prompts: a **shared base prompt** plus a **per-reviewer
focus paragraph**. Each reviewer gets a different focus to maximize coverage
diversity.

Save each to `$out_dir/prompt-{reviewer}.txt`.

The shared base prompt (adapted for PR review context):

```
You are a senior staff engineer performing a rigorous code review. You have
15+ years of experience and a track record of catching subtle, high-impact
bugs before they ship. You are thorough but not pedantic. You care about
correctness, security, and maintainability — not style.

Your task: review the diff at {DIFF_PATH} against the project's conventions
documented in these files:
{PROJECT_DOCS_PATHS}

The PR was authored against commit <head_sha>. Read source files via
`git show <head_sha>:<path>` — the working tree does not match the PR.

The diff is scoped to exactly the changes on this PR. Everything in the diff
is in scope; everything outside is context you may read but should not review.

The PR author describes the change as:
{PR_DESCRIPTION}

Evaluate whether the implementation actually delivers on this description.
If the PR claims to prevent event loss, verify that it does. If it claims
idempotency, check the dedup path. Do not take the description at face value.

Review priorities, in order:

1. CORRECTNESS — bugs, logic errors, off-by-ones, race conditions, unhandled
   errors, incorrect assumptions about external systems, broken invariants,
   dead/unreachable code.
2. CONCURRENCY & ORDERING — async operation sequencing, setup step ordering,
   TOCTOU between async calls, assumptions about which operation completes
   first, whether concurrent writers can produce inconsistent state.
3. SECURITY — injection, authentication/authorization gaps, secret handling,
   input validation, unsafe deserialization, privilege escalation.
4. CONVENTION ADHERENCE — violations of rules explicitly stated in the
   project docs above. Do NOT invent conventions the docs don't mandate.
5. MAINTAINABILITY — only flag things that will actively hurt the next
   engineer to touch this code. Not "could be slightly cleaner."
6. TEST COVERAGE — missing coverage for new logic, tests that assert the
   wrong thing, tests that document gaps instead of fixing them. Only flag if
   the project's docs call test coverage out as required.

What NOT to flag:

- Style, formatting, import ordering, naming nits unless the project docs
  explicitly mandate them.
- Issues the compiler, linter, or typechecker would catch — assume CI exists.
- Pre-existing issues on lines the diff did not modify.
- Missing documentation unless the docs mandate it.
- Renamings, reorganizations, or "this could be factored differently"
  suggestions.
- Pedantic edge cases a senior engineer would not call out in a real PR.

Output: return your findings via the structured output tool you have been
given. Each finding needs: title, severity (critical | high | medium | low |
nit), file (repo-relative path), line_start, line_end, category (correctness
| security | convention | maintainability | tests), finding (one-paragraph
description), why_it_matters (concrete consequence if not fixed),
recommended_fix (specific and actionable — not "consider doing X"), and
confidence (0-100; 100 = certain, 50 = plausible but unverified, 25 = hunch).

If you find nothing worth raising, return an empty findings list and set
clean_reason to a one-sentence justification of why the diff is clean.
```

(For the two Codex lanes, replace the "Output" paragraph in their prompt
files with the original markdown output format — `### <title>` sections with
Severity/File/Category/Finding/Why it matters/Recommended fix/Confidence
bullets, "### No findings" when clean — since Codex returns text that the
lane agent converts to structured output.)

### Per-reviewer focus paragraphs

Append one of these to the base prompt for each reviewer:

**Fable A — Concurrency & async ordering:**
```
YOUR FOCUS: Pay special attention to the ordering of async operations
during setup, teardown, and reconnection. When two async steps happen in
sequence (subscribe then query, or query then subscribe), consider what
happens if the world changes between them. Look for TOCTOU gaps in async
setup sequences, concurrent writers to shared state, and assumptions about
which operation completes first.
```

**Fable B — Goal evaluation & domain logic:**
```
YOUR FOCUS: Read the PR description carefully, then evaluate whether the
implementation actually achieves what it claims. If the PR says "events
are never lost," find a scenario where they could be. If it says
"checkpoint only advances safely," find a case where it doesn't. Be
adversarial about the stated goals — your job is to find the gap between
intent and implementation.
```

**Sonnet — Error handling & failure modes:**
```
YOUR FOCUS: Trace every error path and failure mode. What happens when a
database write fails mid-operation? When a background job exhausts its
retries? When a network call times out during a multi-step process? Look
for silent failures, missing error propagation, and recovery paths that
leave the system in an inconsistent state.
```

**Codex A — Edge cases & boundary conditions:**
```
YOUR FOCUS: Look for edge cases at boundaries. What happens at block 0?
When a range is empty? When both inputs are equal? When an optional value
is None for the first time? When a counter overflows? Find the inputs
that the author probably didn't test.
```

**Codex B — Broad general sweep:**
```
YOUR FOCUS: Do a broad, unbiased review. Don't focus on any particular
category — instead, try to find anything the other reviewers might miss.
Look at the change holistically: does the overall design make sense? Are
there interactions between components that could produce surprising
behavior? Are there implicit assumptions that aren't documented?
```

### Inspector prompts

Write four inspector prompt files the same way. Each contains the full body
of the corresponding command file (everything below the frontmatter, with
`$ARGUMENTS` replaced by the PR reference), plus this shared context block:

```
The diff is at: {DIFF_PATH}
Repo root: {REPO_ROOT}
The PR is at commit <head_sha>. Read source files via
`git show <head_sha>:<path>` — the working tree does not match the PR.
```

plus per-inspector structured-output mapping rules:

- **Test Inspector** (`~/.claude/commands/test-inspector.md` →
  `prompt-test-inspector.txt`): "Read the diff to identify test files. Read
  the full test files and the source files they test. If no test files are
  in the diff, return an empty findings list with clean_reason. Return
  findings via the structured output tool. Category is always 'tests'.
  Severity mapping: useless tests = medium, weak tests = low, missing
  coverage for risky logic = high, mock abuse = medium."
- **Idiomatic Rust Inspector**
  (`~/.claude/commands/idiomatic-rust-inspector.md` →
  `prompt-rust-inspector.txt`): "Read the diff to identify Rust files. Read
  the full files and related type/trait/error definitions. If no Rust files
  are in the diff, return an empty findings list with clean_reason. Return
  findings via the structured output tool. Category: 'maintainability' for
  style/idiom issues, 'correctness' for ownership bugs or unsafe misuse.
  Severity mapping: non-idiomatic with correctness impact = high,
  style-only = medium, suboptimal = low."
- **Strong Typing Inspector**
  (`~/.claude/commands/strong-typing-inspector.md` →
  `prompt-typing-inspector.txt`): "Build the domain-type inventory from the
  repo first, then scan the diff. If the diff has no source files where
  strong typing is relevant, return an empty findings list with
  clean_reason. Return findings via the structured output tool. Category is
  always 'maintainability'. Severity mapping:
  primitive-where-domain-type-exists = medium (high if it touches financial
  values or identifiers), missed-newtype opportunity = low."
- **External Contract Inspector**
  (`~/.claude/commands/external-contract-inspector.md` →
  `prompt-contract-inspector.txt`): "Identify external touchpoints in the
  diff (HTTP/RPC/SDK responses, on-chain ABIs and message formats,
  units/decimals). For each, check whether the assumed shape is backed by a
  cited spec or a test encoding a real response. Read the relevant test
  files and fixtures to decide. If the diff has no external touchpoints,
  return an empty findings list with clean_reason. Return findings via the
  structured output tool. Category is always 'correctness'. Severity is
  risk-weighted: critical for wrong width/unit/encoding at a money or
  on-chain boundary, down to low for cosmetic shape assumptions. The
  recommended_fix should name how to pin the assumption (cite the spec, or
  add the real-response test)."

## 7. Run the review workflow

The whole review — fan-out, dedup, adversarial verification, synthesis —
runs as **one `Workflow` invocation** using the same `review-panel` script
as `/review-loop`. Findings come back schema-validated; no markdown parsing,
no output-file validation, no separate aggregator agent.

### Lanes

Build the lane list (drop the codex lanes if `codex` is not on PATH — check
`command -v codex`; warn the user and continue with 7 lanes):

| key                | codex | model  | promptPath                              |
| ------------------ | ----- | ------ | --------------------------------------- |
| fable-a            | no    | fable  | prompt-fable-a.txt (concurrency)        |
| fable-b            | no    | fable  | prompt-fable-b.txt (goal evaluation)    |
| sonnet             | no    | sonnet | prompt-sonnet.txt (error handling)      |
| codex-a            | yes   | —      | prompt-codex-a.txt (edge cases)         |
| codex-b            | yes   | —      | prompt-codex-b.txt (broad sweep)        |
| test-inspector     | no    | sonnet | prompt-test-inspector.txt               |
| rust-inspector     | no    | fable  | prompt-rust-inspector.txt               |
| typing-inspector   | no    | sonnet | prompt-typing-inspector.txt             |
| contract-inspector | no    | fable  | prompt-contract-inspector.txt           |

Each lane object: `{key, codex, model, promptPath, diffPath}`. All lanes
share `$out_dir/diff.patch`.

### Workflow invocation

Invoke the `Workflow` tool with the script below via `script`, and `args`:

```json
{
  "repoRoot": "<repo_root>",
  "docsPaths": ["<CLAUDE.md/AGENTS.md paths>"],
  "lanes": [ ...lane objects... ],
  "reportHeader": "# Review — PR #<n>: <title>\n**Author:** <author>\n**URL:** <url>\n**Branches:** <head> -> <base>\n**Head SHA:** <head_sha>\n**Files changed:** <N> (+<additions>/-<deletions>)",
  "synthesisExtra": "CRITICAL ADAPTATIONS FOR THIS REPORT: (1) No AI references anywhere — no agent attribution, no 'Found by' field, no mention of models, reviewers, lanes, or cross-review. The report must read like a single human senior engineer wrote it. (2) Frame the Overall assessment as advice to the REVIEWER reading this report, not to the PR author — e.g. 'This PR looks ready to merge pending X' or 'I'd push back on Y before approving.'"
}
```

```javascript
export const meta = {
  name: 'review-panel',
  description: 'Multi-model review panel: parallel review, dedup, adversarial verify, synthesize',
  phases: [
    { title: 'Review', detail: 'reviewers + inspectors in parallel' },
    { title: 'Verify', detail: 'adversarial refuter per deduped finding' },
    { title: 'Synthesize', detail: 'canonical report' },
  ],
}

const FINDING = {
  type: 'object',
  required: ['title', 'severity', 'file', 'line_start', 'line_end', 'category',
    'finding', 'why_it_matters', 'recommended_fix', 'confidence'],
  properties: {
    title: { type: 'string' },
    severity: { enum: ['critical', 'high', 'medium', 'low', 'nit'] },
    file: { type: 'string' },
    line_start: { type: 'integer' },
    line_end: { type: 'integer' },
    category: { enum: ['correctness', 'security', 'convention', 'maintainability', 'tests'] },
    finding: { type: 'string' },
    why_it_matters: { type: 'string' },
    recommended_fix: { type: 'string' },
    confidence: { type: 'integer' },
  },
}

const REVIEW_SCHEMA = {
  type: 'object',
  required: ['findings'],
  properties: {
    findings: { type: 'array', items: FINDING },
    clean_reason: { type: 'string' },
    reviewer_error: { type: 'string' },
  },
}

const VERDICT_SCHEMA = {
  type: 'object',
  required: ['verdict', 'rationale', 'severity', 'confidence'],
  properties: {
    verdict: { enum: ['valid', 'likely', 'disputed', 'invalid', 'out-of-scope'] },
    rationale: { type: 'string' },
    severity: { enum: ['critical', 'high', 'medium', 'low', 'nit'] },
    confidence: { type: 'integer' },
  },
}

// The harness may deliver args as a JSON-encoded string instead of a
// parsed object — parse defensively before destructuring.
const parsedArgs = typeof args === 'string' ? JSON.parse(args) : args
const { repoRoot, docsPaths, lanes, reportHeader, synthesisExtra } = parsedArgs

phase('Review')

const laneResults = await parallel(lanes.map(lane => () => {
  const context = `The diff is at: ${lane.diffPath}\n` +
    `Project docs: ${docsPaths.join(', ')}\n` +
    `Repo root: ${repoRoot}`

  const prompt = lane.codex
    ? `Use Bash to run exactly this command (one call, 10 minute timeout):\n` +
      `cat "${lane.diffPath}" | codex exec --sandbox read-only -m gpt-5.5 ` +
      `-C "${repoRoot}" "$(cat "${lane.promptPath}")"\n` +
      `Codex mixes tool-call logs with the review; the review appears after ` +
      `the last bare 'codex' marker line in stdout, before any 'tokens used' ` +
      `trailer. If the command fails with a rate-limit or quota error, retry ` +
      `once with -m o3. Convert the resulting review into structured ` +
      `findings (parse each ### section into one finding). If codex is ` +
      `unusable, return an empty findings list and set reviewer_error.`
    : `Read the review instructions at ${lane.promptPath} and follow them ` +
      `exactly.\n${context}\nRead the diff, the project docs, and any ` +
      `source files referenced by the diff that you need for context.`

  return agent(prompt, {
    label: `review:${lane.key}`,
    phase: 'Review',
    model: lane.model,
    schema: REVIEW_SCHEMA,
  }).then(result => result && ({
    key: lane.key,
    error: result.reviewer_error || null,
    findings: (result.findings || []).map(finding => ({
      ...finding,
      found_by: [lane.key],
      diff_path: lane.diffPath,
    })),
  }))
}))

const laneErrors = lanes
  .map((lane, index) => {
    const result = laneResults[index]
    if (!result) return `${lane.key}: lane died or was skipped`
    if (result.error) return `${lane.key}: ${result.error}`
    return null
  })
  .filter(Boolean)

const raw = laneResults.filter(Boolean).flatMap(result => result.findings)

const merged = []
for (const finding of raw) {
  const dup = merged.find(existing =>
    existing.file === finding.file &&
    existing.category === finding.category &&
    finding.line_start <= existing.line_end + 3 &&
    existing.line_start <= finding.line_end + 3)
  if (dup) {
    dup.found_by = [...new Set([...dup.found_by, ...finding.found_by])]
    if (finding.confidence > dup.confidence) {
      Object.assign(dup, { ...finding, found_by: dup.found_by })
    }
  } else {
    merged.push({ ...finding })
  }
}
log(`${raw.length} raw findings -> ${merged.length} after dedup; ` +
  `lane errors: ${laneErrors.length}`)

phase('Verify')

const verified = await parallel(merged.map(finding => () =>
  agent(
    `You are adversarially verifying a single code-review finding. Read the ` +
    `actual code before judging — never judge from the finding text alone.\n\n` +
    `Finding: ${JSON.stringify(finding)}\n\n` +
    `The diff is at: ${finding.diff_path}\nRepo root: ${repoRoot}\n\n` +
    `Classify the finding: valid (real, you verified it against the code), ` +
    `likely (probably real but needs more context), disputed (evidence is ` +
    `weak), invalid (false positive — the code contradicts the claim), ` +
    `out-of-scope (real but on lines the diff did not modify). Refute only ` +
    `with concrete evidence from the code; do not dismiss ` +
    `uncertain-but-plausible findings. Re-score severity and confidence ` +
    `from your own reading (confidence 100 = you verified it yourself).`,
    { label: `verify:${finding.file}`, phase: 'Verify', model: 'sonnet',
      schema: VERDICT_SCHEMA },
  ).then(verdict => verdict && ({ ...finding, ...verdict }))
))

const judged = verified.filter(Boolean)
const survivors = judged.filter(finding =>
  finding.verdict === 'valid' || finding.verdict === 'likely' ||
  finding.verdict === 'disputed')
const dismissed = judged.filter(finding =>
  finding.verdict === 'invalid' || finding.verdict === 'out-of-scope')

const sevRank = { critical: 0, high: 1, medium: 2, low: 3, nit: 4 }
const verdictRank = { valid: 0, likely: 1, disputed: 2 }
survivors.sort((first, second) =>
  sevRank[first.severity] - sevRank[second.severity] ||
  verdictRank[first.verdict] - verdictRank[second.verdict] ||
  second.confidence - first.confidence)

phase('Synthesize')

const synthesis = await agent(
  `You are a senior staff engineer writing the canonical report for a ` +
  `multi-reviewer code review. The findings below were already deduplicated ` +
  `and adversarially verified — do not re-litigate verdicts.\n\n` +
  `Report header (use verbatim at the top):\n${reportHeader}\n\n` +
  `Reviewer lanes that errored: ${JSON.stringify(laneErrors)}\n\n` +
  `Verified findings (JSON, pre-sorted): ${JSON.stringify(survivors)}\n\n` +
  `Dismissed findings (JSON): ${JSON.stringify(dismissed)}\n\n` +
  `The diff is at: ${lanes[0].diffPath}. Project docs: ` +
  `${docsPaths.join(', ')}. Read the diff so your overall assessment ` +
  `reflects the actual change, and call out anything the reviewers ` +
  `collectively missed.\n\n` +
  `Produce a markdown report: the header block, "## Summary" (2-3 sentence ` +
  `verdict with valid-finding counts per severity), "## Findings" (one ` +
  `"### [SEVERITY] <title>" section per finding with File, Category, ` +
  `Validity, Confidence, Issue, Why it matters, Recommended fix, and the ` +
  `verifier's rationale as "Verification"), "## Findings dismissed as ` +
  `invalid" (bulleted, one-line rationale each), "## Findings dismissed as ` +
  `out-of-scope", "## Overall assessment" (2-3 paragraphs of your own ` +
  `senior-engineer judgment). No emojis, no apologies, be decisive.` +
  (synthesisExtra ? `\n\n${synthesisExtra}` : ''),
  { label: 'synthesize', phase: 'Synthesize', model: 'fable',
    schema: {
      type: 'object',
      required: ['report_markdown'],
      properties: { report_markdown: { type: 'string' } },
    } },
)

return {
  findings: survivors,
  dismissed,
  laneErrors,
  report: synthesis ? synthesis.report_markdown : null,
}
```

### After the workflow returns

The workflow returns `{findings, dismissed, laneErrors, report}`.

1. Write `report` to `$out_dir/review.md` and the findings JSON to
   `$out_dir/findings.json`. The structured findings keep `found_by`
   attribution for local audit; `review.md` has none.
2. If `laneErrors` is non-empty, tell the user which lanes errored. If **all
   reviewer lanes** errored, stop. (Inspector lanes erroring is non-fatal.)

## 8. Print findings to the terminal

Print a compact summary without agent attribution on each finding:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
PR #<n> — <title>
<author>  ·  <head>..<base>  ·  <N> files, +<add>/-<del> lines
<url>
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

▲ CRITICAL (count)
  1. <title>
     <file>:<line>  confidence: 95
     <one-line fix>
...

▽ Dismissed by verification: <count>

Full report: <absolute path to review.md>
```

## 9. Enter the review conversation

After printing, **stay in the session**. Do not end the turn with a summary
— the user wants to have a conversation about the findings.

Say something like:

> Review saved to `<path>`. Let me know which findings you want to dig into,
> and when you're ready I can post comments on the PR.

Then wait. For any follow-up question:

- **"tell me more about #N"** — read the full finding from `review.md` and
  explain it in conversational form. Read the relevant source via
  `git show $head_sha:<path>` to confirm the claim yourself.
- **"is finding #N actually valid?"** — verify by reading the code at the
  head SHA. Report your independent read.
- **"draft a comment for #N"** — write a PR-comment-style message (concise,
  constructive, cite file/line, propose fix). Show it to the user and wait
  for approval.
- **"post"** or **"post as draft"** — create a **pending (draft) GitHub
  review** with inline comments. See "Posting a draft review" below.
  The user will inspect, edit, and submit from the GitHub UI — no
  per-comment text approval is needed here.
- **"post #N, #M"** — same as "post" but only include the listed findings.
- **"I'm done"** — summarize what was posted (if anything) and end the turn.

### Posting a draft review

When the user says "post" or "post as draft", create a **PENDING** GitHub
review with each finding as an inline comment on its file/line. This lets
the user go to the GitHub UI, inspect each comment, edit or delete as
needed, and click "Submit review" themselves.

**Step 1 — Build the comments JSON.** For each finding, create an inline
comment object. Use the finding's file path and line number from the
review.

**Comment tone rules:**
- Write like a human colleague leaving a quick review comment. Short,
  direct, conversational.
- No numbered prefixes like `#1`, `**#2 (HIGH)**`, etc. Just say what
  the issue is.
- No em dashes. Use commas, periods, or "because" instead.
- **Start each comment with a lowercase severity prefix** that signals
  how important the finding is: `critical:`, `should fix:`, `minor:`,
  or `nit:`. This replaces bold labels and numbered prefixes. The
  prefix is short and natural, like a colleague would write.
- No bullet-point lists inside a single comment unless genuinely needed.
  Prefer short paragraphs.
- Keep each comment to 2-4 sentences. Say what's wrong, why it matters,
  and what to do about it.

**Leave the review `body` empty.** Do NOT post the overall assessment to
the draft — GitHub would attach it as the review summary, and the user
wants to write/paste that themselves at submit time. You'll print the
assessment in the conversation in Step 2 instead.

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

**CRITICAL: Omit the `event` field entirely to create a PENDING review.**
The GitHub API does NOT accept `"event": "PENDING"` — it returns a 422.
Omitting `event` is what makes the review a draft.

This creates a draft review visible only to you (the reviewer) until
submitted. Tell the user the draft is up, then **print the overall
assessment in the conversation as a fenced copy-paste block** so they can
paste it into the review summary box when they submit from the GitHub UI:

> Draft review created with N inline comments. The overall summary is not
> part of the draft — paste this into the review summary box when you
> submit:
>
> ```
> <overall assessment — 2-3 sentences>
> ```
>
> Go to <pr-url> to inspect, edit, or delete comments, then click
> "Submit review."

**CRITICAL: `line` must be a line present in the diff hunk, not any
arbitrary line in the file.** To find the right line number:
- Read the diff (`$out_dir/diff.patch`) and identify the `+`-side line
  number within the changed hunk that best matches the finding
- If the finding points to a line NOT in the diff, use the nearest
  changed line in the same file, or fall back to creating a top-level
  review comment instead of an inline one

**Step 3 — Handle findings without diff lines.** Strongly prefer inline
comments over top-level body text. If a finding references unchanged
code, look for a **related** changed line in the diff where the comment
makes sense contextually. For example, if a finding is about an
interaction between existing code and newly introduced code (e.g., "the
existing reconciler doesn't account for the new compaction policy"),
place the comment on the new code that introduces the interaction, not
on the untouched code. Only when a finding has genuinely no related
changed code anywhere in the diff (e.g., a missing file, a documentation
gap, a broad architectural concern), fold it into the copy-paste
assessment block you print in the conversation (Step 2) rather than the
posted `body` — the draft `body` stays empty. The goal is for the draft
itself to be targeted inline feedback, not a wall of text.

## Hard rules

1. Never check out the PR branch. Work off `gh pr diff` and `git show` at
   the head SHA.
2. `review.md` has no per-finding agent attribution. Keep attribution in
   `findings.json` only.
3. For draft reviews ("post" / "post as draft"), per-comment approval is
   NOT required — the GitHub UI is the approval mechanism. For immediate
   submissions (non-draft), never post without explicit user approval of
   the exact text.
4. Always use `--body-file` (or heredoc to a tempfile) for comment bodies.
5. Stay in the session after printing — this command is a conversation,
   not a one-shot.
6. If the PR is closed/merged/draft, ask before proceeding.
7. **Posted reviews must read like a human wrote them.** No AI references
   (models, agents, Claude, Codex, Gemini). No numbered
   finding prefixes (`#1`, `**#2 (HIGH)**`). No em dashes. No bold
   severity labels. Use lowercase severity prefixes (`critical:`,
   `should fix:`, `minor:`, `nit:`) to signal importance. Write short,
   direct comments like a colleague would. The `findings.json` and
   `review.md` on disk can use structured formatting (they're local),
   but anything posted to GitHub must be conversational and concise.
8. **Maximize inline comments; the draft `body` stays empty.** Never post
   the overall assessment to the draft review — leave `body` empty and
   print the 2-3 sentence assessment in the conversation as a copy-paste
   block for the user to paste at submit time. Every finding should be an
   inline comment on a diff line. When a finding references unchanged
   code, place the comment on the nearest related changed line.
9. The review runs as a single `Workflow` invocation — never hand-roll the
   fan-out with individual Agent calls. `--sandbox read-only` for codex is
   non-negotiable.
