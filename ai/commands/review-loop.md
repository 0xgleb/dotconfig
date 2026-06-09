---
allowed-tools: Bash(gt:*), Bash(git:*), Bash(gh:*), Bash(codex:*), Bash(linear:*), Bash(cargo:*), Bash(mkdir:*), Bash(cat:*), Bash(mktemp:*), Bash(rm:*), Bash(test:*), Bash(grep:*), Bash(wc:*), Bash(date:*), Bash(basename:*), Bash(find:*), Read, Write, Edit, Agent, Workflow, AskUserQuestion
description: Cross-review the current branch with a multi-model Workflow panel (2x Fable, Sonnet, 2x Codex gpt-5.5 + inspectors), auto-fix findings, and re-review until clean. Re-review passes use fast delta verification. Loops automatically — only stops for user input on disputed findings or massive changes. Pass `stack` to run the loop across the whole upstack, amending each branch.
argument-hint: [stack]
---

Run a full self-review loop on the current branch: review → auto-fix →
CI → re-review → repeat until clean. Use this right before you `gt submit`
something you wrote yourself, to catch issues before reviewers do.

The loop is **automatic by default**. Findings that clearly should be fixed
are fixed without asking. The loop re-reviews after each fix pass to catch
issues introduced by the fixes themselves. It stops when a review pass
returns no new actionable findings.

**Speed design:** the **first pass** runs the full multi-model panel. Each
finding is adversarially verified **before** triage so false positives never
cost a fix-and-re-review cycle. A **compile gate** runs after each fix pass
so a broken fix never burns a review pass. **Re-review passes** run in fast
delta mode (per-fix verifiers plus one broad sweep of the fix delta) unless
the fixes were large enough to warrant re-running the full panel.

**Argument:** with no argument, the loop runs on the **current branch only**
and never touches version control (the safe default). With `stack`, it runs
across the **entire upstack** — current branch and every branch above it —
amending each branch as it goes (see **Stack mode** below).

Follow these steps precisely.

---

## Stack mode (`/review-loop stack`)

When invoked with the `stack` argument, wrap the single-branch loop (steps
1–14) in an upstack walk: review-loop the current branch, fold the fixes into
its commit, move up, and repeat until the top of the stack. Passing `stack` is
an explicit opt-in to the amend-and-advance flow, so in stack mode **hard rule
#4 is relaxed**: you MAY `gt modify -a` to amend fixes into the current
branch before moving up. You still never `gt submit`/push without the user
asking.

With no `stack` argument, skip this section entirely and run steps 1–14 once
on the current branch.

### Stack flow

1. Record the starting branch: `git branch --show-current`. You return here at
   the very end.
2. Run the full single-branch loop (**steps 1–14**) on the current branch.
   - **Relax the step-1 clean-tree gate after the first branch**: `gt up`
     restacks descendants, so a non-empty tree from that is expected. Still
     stop if there are unrelated uncommitted edits you did not make.
3. After the loop converges clean and `/ci` has passed, if any files were
   modified on this branch (by fixes or by `/ci`), amend them into the
   branch's commit with `gt modify -a` (invoke the `graphite` skill). This
   also restacks descendants. If nothing was modified, skip the amend.
4. Move up the stack with `gt up` (via the `graphite` skill):
   - If `gt up` succeeds and the branch changed, print
     `"Moving up stack -> <new branch>"` and repeat from step 2.
   - If `gt up` fails or the branch did not change, you are at the top. Print
     `"Reached top of stack."` and end the stack walk.
5. If the single-branch loop **fails to converge** on any branch (hits the
   4-pass cap), stop on that branch — do **NOT** continue up the stack. Report
   which branch is stuck and follow the normal non-convergence flow.
6. When done (success or failure), return to the starting branch
   (`gt checkout <starting-branch>`) and print a per-branch summary:
   ```
   Stack review-loop summary:
     branch-a: converged clean (fixed 3, amended)
     branch-b: converged clean (no changes)
     branch-c: stuck (4-pass cap — see above)
   ```

Each branch gets its own review directory (the step-2 `out_dir` is
branch-named), its own diff against its own `gt parent`, and its own 4-pass
cap. The Defer-to-Linear step (13) still applies per branch.

---

## 1. Preflight

Verify prerequisites before doing anything:

1. You are in a git repo with a graphite-tracked branch:
   ```bash
   git rev-parse --show-toplevel
   gt log short
   ```

2. `codex` and `gt` are on PATH:
   ```bash
   command -v codex gt
   ```
   If `codex` is missing, warn the user and drop the two Codex lanes from the
   panel (7 lanes instead of 9). Seven lanes is still valuable.

3. The working tree is clean or stashed. A dirty tree pollutes the diff
   and confuses reviewers:
   ```bash
   git status --porcelain
   ```
   If dirty, tell the user and stop.

## 2. Resolve scope & prepare workspace

Determine what to review. On a graphite stack, **always diff against `gt
parent`**, not trunk — reviewing against trunk on a stacked branch would
include ancestor PRs and drown the reviewers in unrelated changes.

```bash
default_branch=$(git symbolic-ref refs/remotes/origin/HEAD --short 2>/dev/null || echo origin/master)
parent=$(gt parent 2>/dev/null || git merge-base "$default_branch" HEAD)
branch=$(git rev-parse --abbrev-ref HEAD)
head_sha=$(git rev-parse HEAD)
parent_sha=$(git rev-parse "$parent")
repo_root=$(git rev-parse --show-toplevel)
ts=$(date +%Y-%m-%d_%H-%M-%S)
safe_branch=$(echo "$branch" | tr '/' '_')
out_dir="$repo_root/claude-local-ctx/reviews/${ts}-${safe_branch}"
mkdir -p "$out_dir"
```

Write the diff and file manifest. Diff against the working tree (no `..HEAD`)
so re-review iterations automatically include uncommitted fixes:

```bash
git diff "$parent" > "$out_dir/diff.patch"
git diff --name-status "$parent" > "$out_dir/files.txt"
wc -l "$out_dir/diff.patch"
```

Refuse to proceed if the diff is empty. If it exceeds 5000 lines, warn the
user and ask whether to proceed — reviewer quality degrades on huge diffs.

**Ensure the local-ctx folder is gitignored.** If `claude-local-ctx/` is not
in `.gitignore` (check with `grep -q claude-local-ctx "$repo_root/.gitignore"`),
ask the user for permission to add it. Do not silently modify `.gitignore`.

## 3. Load project context

```bash
find "$repo_root" -maxdepth 3 \( -name "CLAUDE.md" -o -name "AGENTS.md" \) \
  -not -path "*/node_modules/*" -not -path "*/target/*"
```

Keep only the paths. Reviewers will read them themselves.

Also extract the PR description if a PR exists for this branch:

```bash
pr_body=$(gh pr view --json body --jq '.body' 2>/dev/null || echo "No PR description available.")
```

Strip bot-appended footers before embedding the description in prompts:
cut everything from the first HTML-comment footer marker onward (e.g.
`<!-- codesmith:footer -->`, CodeRabbit/Codesmith badges, tracking links).
Reviewers should see only the author-written description — bot HTML wastes
their context and can mislead the goal-evaluation lane.

## 4. Build the reviewer prompts

Every reviewer gets a **shared base prompt** plus a **per-reviewer focus
paragraph** that biases each toward a different class of bugs.

### Base prompt

Save this to `$out_dir/prompt-base.txt`:

```
You are a senior staff engineer performing a rigorous code review. You have
15+ years of experience and a track record of catching subtle, high-impact
bugs before they ship. You are thorough but not pedantic. You care about
correctness, security, and maintainability — not style.

Your task: review the diff at {DIFF_PATH} against the project's conventions
documented in these files:
{PROJECT_DOCS_PATHS}

The diff is scoped to exactly the changes on the current PR (parent..HEAD on a
graphite stack). Everything in the diff is in scope; everything outside is
context you may read but should not review.

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

Save each complete prompt (base + focus) to `$out_dir/prompt-{reviewer}.txt`.

### Inspector prompts

Write four inspector prompt files the same way. Each contains the full body
of the corresponding command file (everything below the frontmatter, with
`$ARGUMENTS` replaced by the empty string — use the current branch), plus an
appended context block, plus structured-output mapping rules:

**Test Inspector** — `$out_dir/prompt-test-inspector.txt` from
`~/.claude/commands/test-inspector.md`. Append:

```
The diff is at: {DIFF_PATH}
Repo root: {REPO_ROOT}

Read the diff to identify test files. Read the full test files and the
source files they test. If no test files are in the diff, return an empty
findings list with clean_reason "no test files in diff".

Return findings via the structured output tool. Category is always "tests".
Severity mapping: useless tests = medium, weak tests = low, missing coverage
for risky logic = high, mock abuse = medium.
```

**Idiomatic Rust Inspector** — `$out_dir/prompt-rust-inspector.txt` from
`~/.claude/commands/idiomatic-rust-inspector.md`. Append:

```
The diff is at: {DIFF_PATH}
Repo root: {REPO_ROOT}

Read the diff to identify Rust files. Read the full files and related
type/trait/error definitions. If no Rust files are in the diff, return an
empty findings list with clean_reason "no Rust files in diff".

Return findings via the structured output tool. Category: "maintainability"
for style/idiom issues, "correctness" for ownership bugs or unsafe misuse.
Severity mapping: non-idiomatic with correctness impact = high, non-idiomatic
style-only = medium, suboptimal = low.
```

**Strong Typing Inspector** — `$out_dir/prompt-typing-inspector.txt` from
`~/.claude/commands/strong-typing-inspector.md`. Append:

```
The diff is at: {DIFF_PATH}
Repo root: {REPO_ROOT}

Build the domain-type inventory from the repo first, then scan the diff.
If the diff has no source files where strong typing is relevant, return an
empty findings list with clean_reason.

Return findings via the structured output tool. Category is always
"maintainability". Severity mapping: primitive-where-domain-type-exists =
medium (high if it touches financial values or identifiers), missed-newtype
opportunity = low.
```

**External Contract Inspector** — `$out_dir/prompt-contract-inspector.txt`
from `~/.claude/commands/external-contract-inspector.md`. Append:

```
The diff is at: {DIFF_PATH}
Repo root: {REPO_ROOT}

Identify external touchpoints in the diff (HTTP/RPC/SDK responses, on-chain
ABIs and message formats, units/decimals). For each, check whether the
assumed shape is backed by a cited spec or a test encoding a real response.
Read the relevant test files and fixtures to decide. If the diff has no
external touchpoints, return an empty findings list with clean_reason.

Return findings via the structured output tool. Category is always
"correctness". Severity is risk-weighted: critical for wrong
width/unit/encoding at a money or on-chain boundary, down to low for
cosmetic shape assumptions. The recommended_fix should name how to pin the
assumption (cite the spec, or add the real-response test).
```

## 5. Run the review workflow

The whole review pass — fan-out, dedup, adversarial verification, synthesis —
runs as **one `Workflow` invocation**. Findings come back schema-validated,
so there is no markdown parsing, no output-file validation, and no separate
aggregator agent in the main session.

### Lanes

Build the lane list (drop the codex lanes if `codex` is not on PATH):

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

Each lane object: `{key, codex, model, promptPath, diffPath}`. Normally all
lanes share `$out_dir/diff.patch`; chunked runs differ (see below).

### Workflow invocation

Invoke the `Workflow` tool with the script below via `script`, and `args`:

```json
{
  "repoRoot": "<repo_root>",
  "docsPaths": ["<CLAUDE.md/AGENTS.md paths>"],
  "lanes": [ ...lane objects... ],
  "reportHeader": "# Review — <branch>\n**Commit:** <head_sha>\n**Parent:** <parent_sha> (<parent branch>)\n**Files changed:** <N>\n**Diff size:** <LOC> lines\n**Panel:** 2x Fable, Sonnet, 2x Codex gpt-5.5, 4 inspectors; per-finding verification; Fable synthesis",
  "synthesisExtra": ""
}
```

The tool result includes a `scriptPath` — reuse it (`{scriptPath, args}`) for
later full-panel passes instead of resending the script.

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
  `Validity, Confidence, Found by, Issue, Why it matters, Recommended fix, ` +
  `and the verifier's rationale as "Verification"), "## Findings dismissed ` +
  `as invalid" (bulleted, one-line rationale each), "## Findings dismissed ` +
  `as out-of-scope", "## Overall assessment" (2-3 paragraphs of your own ` +
  `senior-engineer judgment on merge readiness). No emojis, no apologies, ` +
  `be decisive.` +
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

### Chunk splitting for large diffs

If the diff exceeds **3,500 lines**, split it into domain-based chunks to
keep each reviewer within quality range. Each chunk should be under ~3,500
lines.

1. Read `$out_dir/files.txt` to understand which files changed.
2. Group files by domain/crate/directory into logical chunks.
3. Generate per-chunk diffs using `git diff` with path filters:
   ```bash
   git diff "$parent" -- 'crates/dto/' 'crates/finance/' > "$out_dir/chunk-a.patch"
   ```
4. Verify all files are covered.
5. Report chunk sizes to the user before proceeding.
6. Duplicate the five reviewer lanes per chunk (keys like `fable-a-chunk-b`),
   each with its chunk's `diffPath`. Inspector lanes run once on the full
   diff. Pass all lanes to a single workflow invocation — dedup and
   verification handle the rest.

Skip chunking for diffs under 3,500 lines, single-directory diffs, or if the
user explicitly asks for a single-pass review.

### After the workflow returns

The workflow returns `{findings, dismissed, laneErrors, report}`.

1. Write `report` to `$out_dir/review.md` and the findings JSON to
   `$out_dir/findings.json` (audit trail).
2. If `laneErrors` is non-empty, tell the user which lanes errored. If **all
   reviewer lanes** errored, stop.
3. If `findings` is empty, the pass is clean.

## 6. (Reserved)

Aggregation now happens inside the workflow (step 5). There is no separate
aggregator step.

## 7. Print findings to the terminal

Print a compact, scannable summary from the returned `findings`:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Review — <branch>
<N> files, <LOC> lines changed
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

▲ CRITICAL (count)
  1. <title>
     <file>:<line>  [fable-a, codex-b]  confidence: 95
     <one-line fix>

▲ HIGH (count)
  ...

▲ MEDIUM (count)
  ...

▲ LOW (count)
  ...

▲ NIT (count)
  ...

▽ Dismissed by verification: <count>

Full report: <absolute path to review.md>
```

Keep each finding to **two lines**: title line (title + lanes + confidence)
and fix line (recommended fix). The full details live in `review.md`.

If the review reports **no findings**, print that prominently and exit —
nothing to loop over.

---

## 8. Triage input

Triage works directly on the structured `findings` array returned by the
workflow (also saved to `findings.json`) — no report parsing. Each finding
already carries: `title`, `severity` (re-scored by the verifier), `verdict`
(valid | likely | disputed), `confidence` (re-scored), `category`, `file` +
`line_start`/`line_end`, `finding`, `recommended_fix`, and the verifier's
`rationale`.

Findings the verifier judged `invalid` or `out-of-scope` are already in the
`dismissed` list — never triage those.

## 9. Build the triage plan

For each remaining finding, compute a **default action** based on severity,
verdict, and confidence. **Bias heavily toward fixing now** — only defer
when the fix is massive enough to warrant its own stacked PR.

| Severity   | Verdict  | Confidence | Default action |
| ---------- | -------- | ---------- | -------------- |
| critical   | any      | any        | **Auto-fix**   |
| high       | valid    | >= 50      | **Auto-fix**   |
| high       | likely   | >= 50      | **Auto-fix**   |
| high       | disputed | any        | **Discuss**    |
| medium     | valid    | >= 50      | **Auto-fix**   |
| medium     | likely   | >= 50      | **Auto-fix**   |
| medium     | disputed | any        | **Discuss**    |
| low        | valid    | >= 75      | **Auto-fix**   |
| low        | any      | < 75       | **Auto-dismiss** |
| nit        | any      | any        | **Auto-dismiss** |

**Auto-fix**: apply the fix immediately without asking. No user input needed.

**Auto-dismiss**: drop the finding silently. No user input needed.

**Discuss**: the evidence is weak or reviewers disagree. Show the user the
full finding and ask what to do. Default to fixing unless it's massive.

**Defer to Linear** is NOT a default action. Only use it when:
- The user explicitly asks to defer a specific finding, OR
- A fix is large enough that it should be a separate stacked PR (e.g.,
  a multi-file refactor or new feature, not a surgical bug fix)

When in doubt, fix it now.

## 10. Present the plan and auto-apply

Print the plan as a table, in severity order:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Review-loop triage — <N> findings (iteration <I>)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

 # | sev      | action       | title
---+----------+--------------+------------------------
 1 | critical | auto-fix     | Off-by-one in batch loop
 2 | high     | auto-fix     | Missing auth check on /admin
 3 | medium   | auto-fix     | Add retry on transient errors
 4 | medium   | DISCUSS      | Lock contention in hot path
 5 | nit      | auto-dismiss | Rename variable for clarity

Full details: <path to review.md>
```

**Auto-fix and auto-dismiss findings proceed immediately — no user input.**

For **discuss** findings only, use `AskUserQuestion`:

```
Q: [#N] <title> — sev <severity>. Reviewers disagree — what should I do?
   options:
     - "Fix now" (Recommended) — implement the fix in this session
     - "Dismiss" — drop it, not a real issue
     - "Defer" — too large for this PR, will stack separately
     - "Show me the details" — read the full finding first
```

If the user picks "Show me the details", present the finding
conversationally and re-ask without that option.

After resolving discuss items, print the consolidated plan:

```
Plan:
  Fix now (4):     #1, #2, #3, #4
  Dismiss (1):     #5
```

## 11. Fix-now loop

For each "fix now" finding, in severity order:

1. Announce which one you're addressing.
2. Read the relevant source file(s).
3. Verify the finding is still valid (the code may have been edited since
   the review — re-read, don't trust the report blindly).
4. Apply the recommended fix using `Edit` (or `Write` for new files). Keep
   the change surgical — do not drift into unrelated cleanups. Match the
   project's style.
5. If the fix touches tests or requires them, add/update the tests. If the
   user's project docs (`CLAUDE.md`/`AGENTS.md`) mandate test coverage for
   the kind of logic being fixed, add tests even if the finding didn't
   mention it.
6. Print a one-line summary of what changed.
7. Do **not** run the full test suite, lints, or commit yet — `/ci` runs
   only after the review loop converges.

If while implementing a fix you realize it's larger than expected or the
finding is more nuanced than the report suggests, stop and tell the user.
Offer to re-triage (defer, dismiss, or adjust the fix).

### Compile gate

After all fix-now items are done, run the **compile gate** before any
re-review: the project's fastest typecheck scoped to what was touched (for
Rust, `cargo check -p <touched crates>`; otherwise the project's equivalent).
Fix any compile errors immediately — never enter a re-review pass with code
that doesn't compile; that wastes an entire review pass. The compile gate is
NOT a substitute for `/ci` — full tests and lints still run only after
convergence.

Then proceed directly to step 12 (re-review).

## 12. Re-review loop (delta mode)

Re-review after every fix pass to catch issues introduced by the fixes. This
is the core of the automatic loop.

**CRITICAL: The re-review is NOT optional.** After fixing findings, you
MUST re-review at least once. Do not skip it because the fixes "looked
straightforward" or "were simple." Only a review pass determines when the
loop is done, not your judgment.

**CRITICAL: Convergence requires a CLEAN review pass.** The loop is ONLY
done when a review pass returns no new actionable findings. Fixing the
last batch of findings is NOT convergence. The pattern is always:
`review → fix → review → fix → review(clean) → /ci → done`. You can
never end on a fix — you must always end on a clean review. `/ci` runs
only after convergence, and if it makes changes, you re-enter the loop.

### Choose the re-review mode

Compute the fix delta (everything the loop has changed so far —
fixes are uncommitted, so this is the working-tree diff against HEAD):

```bash
git diff HEAD > "$out_dir/delta-iter${N}.patch"
git diff HEAD --stat | tail -1
git diff "$parent" > "$out_dir/diff-iter${N}.patch"   # updated full diff
```

**Escalate to a full panel pass** (re-run steps 4–7 with the updated full
diff; reuse the workflow `scriptPath`) only when:
- the fix delta exceeds ~200 changed lines, OR
- the fixes touched files that no fixed finding implicated (scope grew).

**Otherwise run delta mode** — the default and the fast path. One small
workflow: a fix-verifier per fixed finding plus one Fable broad sweep of the
fix delta:

```javascript
export const meta = {
  name: 'review-delta',
  description: 'Verify applied fixes and sweep the fix delta for new issues',
  phases: [
    { title: 'Verify fixes', detail: 'one verifier per fixed finding' },
    { title: 'Sweep', detail: 'broad review of the fix delta' },
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

const VERIFY_FIX_SCHEMA = {
  type: 'object',
  required: ['fixed', 'rationale'],
  properties: {
    fixed: { type: 'boolean' },
    rationale: { type: 'string' },
    new_issues: { type: 'array', items: FINDING },
  },
}

const SWEEP_SCHEMA = {
  type: 'object',
  required: ['findings'],
  properties: {
    findings: { type: 'array', items: FINDING },
    clean_reason: { type: 'string' },
  },
}

// The harness may deliver args as a JSON-encoded string instead of a
// parsed object — parse defensively before destructuring.
const parsedArgs = typeof args === 'string' ? JSON.parse(args) : args
const { fixedFindings, deltaDiffPath, fullDiffPath, repoRoot, docsPaths } = parsedArgs

const [verifications, sweep] = await parallel([
  () => parallel(fixedFindings.map(finding => () =>
    agent(
      `A code review flagged this finding and a fix was applied:\n` +
      `${JSON.stringify(finding)}\n\n` +
      `The fix delta (uncommitted changes) is at: ${deltaDiffPath}\n` +
      `The full PR diff (context) is at: ${fullDiffPath}\n` +
      `Repo root: ${repoRoot}\n\n` +
      `Read the current source at the finding's location. Confirm the fix ` +
      `fully resolves the finding — not partially, not by suppressing the ` +
      `symptom — and check the surrounding code for issues the fix may ` +
      `have introduced. Report new_issues only for problems caused by or ` +
      `directly adjacent to the fix.`,
      { label: `verify-fix:${finding.title}`, phase: 'Verify fixes',
        model: 'sonnet', schema: VERIFY_FIX_SCHEMA },
    ).then(result => result && ({ finding, ...result })))),
  () => agent(
    `You are a senior staff engineer reviewing a set of fixes applied in ` +
    `response to a code review. The fix delta is at: ${deltaDiffPath}. ` +
    `The full PR diff (context) is at: ${fullDiffPath}. Project docs: ` +
    `${docsPaths.join(', ')}. Repo root: ${repoRoot}.\n\n` +
    `Review the fix delta holistically: bugs, broken invariants, ` +
    `interactions with the rest of the PR, convention violations from the ` +
    `project docs. Apply the same bar as a full review — correctness ` +
    `first, no style nits, nothing the compiler or linter would catch. ` +
    `Return findings, or an empty list with clean_reason if clean.`,
    { label: 'delta-sweep', phase: 'Sweep', model: 'fable',
      schema: SWEEP_SCHEMA }),
])

return {
  verifications: (verifications || []).filter(Boolean),
  sweepFindings: sweep ? sweep.findings : [],
}
```

Pass `args`: `{fixedFindings: <findings fixed this loop so far>,
deltaDiffPath, fullDiffPath, repoRoot, docsPaths}`. Reuse the returned
`scriptPath` on subsequent delta passes.

### Interpret the result

1. Save the result to `$out_dir/delta-iter${N}.json` (audit trail).
2. **Clean pass** = every verification has `fixed: true` with no
   `new_issues`, and `sweepFindings` is empty. The loop has converged.
   Run `/ci` (invoke the `ci` skill) and let it run until it passes or it
   asks the user for help. `/ci`'s own "amend via `gt modify -a` on
   success" step is overridden by this loop: never amend in single-branch
   mode (hard rule 4 — the user drives version control); in stack mode the
   stack flow amends once per branch after convergence, so `/ci` must not
   amend separately there either.
   - If `/ci` made **no code changes**: proceed to step 13/14.
   - If `/ci` **made code changes** (lint, formatting): run one more delta
     pass over the new delta. This converges quickly since `/ci` changes are
     mechanical.
3. **Not clean**: collect unresolved findings (`fixed: false` — re-fix),
   `new_issues`, and `sweepFindings`. Filter out anything substantively
   identical to a finding already fixed or dismissed (compare file + line
   range + description). If nothing remains, treat as clean. Otherwise
   increment the iteration counter and loop back to step 9 (triage) with
   only the remaining findings.

**Cap at 4 review passes total** (full or delta — initial + up to 3
re-reviews). If new findings keep appearing after 4 passes, stop and tell
the user — the fixes are likely introducing as many issues as they solve,
and a human needs to assess the approach.

Print a status line at the start of each iteration:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Re-review iteration <N> (<delta|full panel>) — checking for new issues
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

## 13. Defer-to-Linear loop (only if user explicitly deferred findings)

This step only runs if the user chose "Defer" for any discuss finding.
Skip entirely if no findings were deferred.

For each "defer" finding, invoke the `linear-cli` skill. For each one:

1. **Draft the issue** in a tempfile, following the linear-cli skill's
   "Drafting issues from review findings" pattern:

   - **Title:** a concise imperative summary derived from the finding title.
     Lead with the action, not the problem. Example: "Add retry on
     transient HTTP errors in broker client" not "Missing retry".
   - **Body** (in the tempfile):

     ```markdown
     ## Problem

     <issue text from the finding>

     ## Evidence

     - File: `<path>:<line-range>`
     - Finding category: <correctness | security | convention | ...>
     - Severity: <severity>
     - Found during review of branch `<branch>` (commit `<sha>`)

     ## Proposed fix

     <recommended_fix from the finding>

     ## Verification rationale

     <the verifier's rationale from the finding>

     ---

     Deferred from review `<path to review.md>`.
     ```

2. **Choose metadata**: priority by severity (critical -> urgent, high ->
   high, medium -> medium, low -> low, nit -> low). Labels: prefer `bug`
   for correctness/security, `tech-debt` for maintainability, `test` for
   test-coverage findings. Project and team come from the repo's
   `.linear.toml` — let `linear` pick them up automatically. Do not pass
   `--team` or `--project` unless the user tells you which ones.

3. **Show the draft to the user** before running any `linear` command.
   Format:

   ```
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   Draft Linear issue — [#N] <finding title>
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   Title:    <draft title>
   Priority: <severity-derived>
   Labels:   <labels>

   <body contents>
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   ```

4. **Ask for confirmation**, using `AskUserQuestion`:

   ```
   Q: Create this Linear issue for finding #N?
     options:
       - "Create"    (Recommended)
       - "Edit"      — tell me what to change
       - "Skip"      — don't create this one
   ```

   If the user picks "Edit", ask what to change, revise, and re-confirm.

5. **Create the issue** only after explicit confirmation:

   ```bash
   body_file=$(mktemp -t linear-issue.XXXXXX.md)
   cat > "$body_file" <<'EOF'
   <approved body>
   EOF
   linear issue create \
     --title "<approved title>" \
     --description-file "$body_file" \
     --priority <severity-derived> \
     --label <labels>
   rm "$body_file"
   ```

6. **Print the issue URL** returned by `linear issue create` and record the
   issue ID — you'll reference them in the summary.

You can batch the confirmation step: if there are multiple "defer" findings,
draft all of them first, show all drafts, ask in one `AskUserQuestion`
call (up to 4 at a time). Don't skip showing the drafts — the user must see
the title and body before any issue is created.

## 14. Summarize

After all review iterations converge (no new findings) and any deferred
Linear issues are created (or skipped), print a final summary:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Review loop complete — <N> iteration(s), converged clean
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Fixed (3):
  #1  critical  Off-by-one in batch loop               <file>:<line>
  #2  high      Missing auth check on /admin            <file>:<line>
  #4  medium    Lock contention in hot path             <file>:<line>

Deferred to Linear (1):
  #3  medium    Add retry on transient errors           <linear url>

Dismissed (1):
  #5  nit       Rename variable for clarity

Reports: <paths to review.md and delta-iter*.json>
```

Then stop. Do not auto-run `gt modify`, `gt submit`, or any other
mutation — the user decides when to amend and push.

**In stack mode**, this is where the single-branch loop returns to the Stack
flow: the wrapper amends the branch (`gt modify -a`) and moves up. Print the
per-branch summary line, then continue the upstack walk — do not stop here.

---

## Failure modes

- **All reviewer lanes error:** stop immediately, tell the user, don't
  proceed to triage. (Inspector lanes erroring is non-fatal.)
- **Review returns no findings:** print "No findings" and exit the command
  successfully — nothing to loop over.
- **A fix turns out to be larger than expected:** stop, report progress,
  ask whether to continue, defer to a stacked PR, or dismiss.
- **Review pass cap hit (4 passes):** stop and tell the user. Summarize
  what was fixed in each iteration and what new issues keep appearing. The
  fixes are likely introducing as many issues as they solve.
- **The workflow itself fails mid-run:** relaunch with
  `{scriptPath, args, resumeFromRunId}` — completed lanes return cached
  results instantly; only the failed part re-runs.
- **A Linear issue fails to create:** report the exact `linear` error,
  leave the draft tempfile in place, and continue with the rest of the
  deferred items. Ask the user whether to retry the failed one at the end.
- **The user says "stop" mid-loop:** immediately stop, then print the
  summary with what was completed so far. Do not silently abandon the rest.
- **Codex not installed:** warn the user and drop the codex lanes
  (7 lanes instead of 9). Seven lanes is still valuable.

## Hard rules

1. **Auto-fix without asking** for findings that match auto-fix criteria.
   Only ask the user about "discuss" findings.
2. **Bias toward fixing now.** Defer to Linear only when the user explicitly
   asks or the fix is too large for the current PR.
3. Never create Linear issues without explicit per-issue user confirmation
   of the exact draft content.
4. Never amend, commit, or `gt submit` automatically — the user drives
   version control. **Exception (stack mode only):** when invoked with the
   `stack` argument, `gt modify -a` to amend fixes into the current branch
   before moving up is expected and allowed. Never `gt submit`/push without
   the user asking, even in stack mode.
5. Always use `--description-file` with `linear issue create`, never inline
   `--description`.
6. Always re-verify findings against the current source before applying
   fixes — the code may have changed since the review.
7. Keep fixes surgical. No "while I'm here" cleanups.
8. Run the compile gate after every fix pass; run `/ci` only after the
   review loop converges clean. If `/ci` makes code changes, run another
   delta pass.
9. Cap at 4 review passes (full or delta). Convergence requires a clean
   pass — never end on a fix. Stop and ask the user if you don't converge.
10. The review pass runs as a single `Workflow` invocation — never run
    reviewers sequentially or hand-roll the fan-out with individual Agent
    calls.
11. Use `--sandbox read-only` for codex — non-negotiable.
12. Verification and synthesis happen inside the workflow, never in the
    main session (context pollution).
13. Never fabricate findings when a lane errors — record the failure from
    `laneErrors`.
14. Save `review.md`, `findings.json`, and delta results to `$out_dir`
    before printing to the terminal.
15. Never silently modify `.gitignore` — ask permission to add
    `claude-local-ctx/` if missing.
16. Delta mode is only valid when the fix delta is small (~200 lines) and
    confined to files implicated by fixed findings — otherwise escalate to
    a full panel pass.
