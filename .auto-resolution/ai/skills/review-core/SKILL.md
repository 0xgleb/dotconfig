---
name: review-core
description: Internal shared review-engine reference for the review-loop, review-pr, and review-sweep skills. Not a user task and never invoked directly; those skills read this file to run the multi-model panel, probes, prompts, and finding output.
allowed-tools: Bash(claude:*), Bash(command:*), Bash(cat:*), Bash(find:*), Bash(mkdir:*), Bash(wc:*), Read, Write, Agent, Workflow
---

# Review engine (shared)

## Provider constraint (overrides every model cell below)

Anthropic API billing is disabled. Every native Workflow agent, verifier,
synthesizer, inspector, and external-command wrapper MUST use
`openai-codex/gpt-5.6-luna`, regardless of legacy lane names such as `fable`,
`sonnet`, or `opus` and regardless of model values shown in older tables below.
Those names are focus labels only. Never pass `fable`, `sonnet`, `opus`,
`claude-*`, or `anthropic/*` as a Workflow `model`.

Claude is optional and may run only through a subscription CLI external lane:

```bash
claude -p --permission-mode plan --model sonnet --no-session-persistence \
  --allowedTools "Read,Grep,Glob,Bash(git show *)" \
  "$(cat \"<promptPath>\") The diff to review is at: <diffPath>"
```

The Pi wrapper for that external command still uses
`openai-codex/gpt-5.6-luna`. Cursor is retired and must never be probed or
launched. If `claude -p` is unavailable or fails, omit Claude and continue the
OpenAI-only panel. Legacy lane names below are focus labels only; every native
Workflow lane uses the provider constraint above.

This is **not a user-facing skill**. It is the single source of truth for the
review engine that `review-loop`, `review-pr`, and `review-sweep` share: turn a
**diff** into **deduplicated, adversarially verified findings** and a canonical
report. The caller decides where the diff comes from and what to do with the
findings; everything between is here.

Do not invoke this skill on its own. A caller follows these steps after it has
produced a diff, then takes its own action on the returned findings.

## The contract (caller-provided inputs)

The caller resolves these before entering the engine and substitutes them where
the steps below reference `{NAME}`:

| Input               | What it is                                                                 |
| ------------------- | ------------------------------------------------------------------------- |
| `out_dir`           | Absolute artifact dir (already created, under a gitignored `.tmp/` root).  |
| `{DIFF_PATH}`       | Path to the unified diff to review (`$out_dir/diff.patch`).                |
| `{FILES_PATH}`      | Path to the name-status manifest (`$out_dir/files.txt`). Caller-only — the workflow never reads it; it feeds chunking and the file count. |
| `{REPO_ROOT}`       | Repo root.                                                                 |
| `{PROJECT_DOCS_PATHS}` | Comma-separated `CLAUDE.md`/`AGENTS.md` paths (caller discovers them).  |
| `{PR_DESCRIPTION}`  | Author-written description, bot footers stripped (or "No description").    |
| `{SOURCE_ACCESS}`   | One paragraph telling reviewers **how to read source** (working tree vs `git show <sha>:<path>`). See callers. |
| `{SOURCE_REVISION}` | Exact 40–64 character lowercase hex Git object ID for no-checkout PR-head access, or omitted for working-tree reviews. |
| `{SCOPE_NOTE}`      | One sentence describing **what the diff is scoped to** (branch vs PR).     |
| `{INSPECTOR_ARG}`   | The value to substitute for `$ARGUMENTS` in inspector bodies (`""` for a branch, the PR ref for a PR). |
| `{REPORT_HEADER}`   | Markdown header block placed verbatim atop the synthesized report.         |
| `{TERMINAL_HEADER}` | The boxed header line(s) for the terminal summary (step 7).                |
| `{SYNTHESIS_EXTRA}` | Extra synthesis instructions, or `""`. PR review passes the no-AI-references / frame-to-reviewer block. |
| `{INCLUDE_ATTRIBUTION}` | `true` to keep `Found by` lane attribution in the report and terminal output; `false` to strip it (PR review). |

## 1. Resolve the available review lanes

The native Workflow panel is always available and every native lane uses
`openai-codex/gpt-5.6-luna` under the provider constraint above. Cursor is
retired: never probe it, cache its availability, or launch a Cursor lane.

Optionally add one read-only Claude Code subscription lane when `claude -p` is
available. Its failure is non-fatal: omit it and continue the OpenAI-only panel.
Lane names such as `fable`, `opus`, and `sonnet` remain focus labels, not model
identifiers. Never pass those names as Workflow models.

## 2. Build the reviewer prompts

Every reviewer gets a **shared base prompt** plus a **per-reviewer focus
paragraph** that biases each toward a different class of bugs. Save each complete
prompt (base + focus) to `$out_dir/prompt-{reviewer}.txt`.

### Base prompt

Save this to `$out_dir/prompt-base.txt`, substituting the contract placeholders:

```
You are a senior staff engineer performing a rigorous code review. You have
15+ years of experience and a track record of catching subtle, high-impact
bugs before they ship. You are thorough but not pedantic. You care about
correctness, security, and maintainability — not style.

Your task: review the diff at {DIFF_PATH} against the project's conventions
documented in these files:
{PROJECT_DOCS_PATHS}

{SOURCE_ACCESS}

{SCOPE_NOTE} Everything in the diff is in scope; everything outside is context
you may read but should not review.

The author describes the change as:
{PR_DESCRIPTION}

Evaluate whether the implementation actually delivers on this description.
If the change claims to prevent event loss, verify that it does. If it claims
idempotency, check the dedup path. Do not take the description at face value.

Review priorities, in order:

1. CORRECTNESS — bugs, logic errors, off-by-ones, race conditions, unhandled
   errors, incorrect assumptions about external systems, broken invariants,
   dead/unreachable code.
1A. SYSTEM INVARIANTS — reconstruct canonical state, conservation/accounting
   identities, temporal consistency, and reconciliation across persistence,
   aggregates, APIs, and user-visible projections. Locally valid pieces do not
   prove whole-system consistency.
1B. ARCHITECTURE DIRECTION — when the change affects ownership, subsystem or
   public boundaries, persistence/transport/deployment, or dependencies, judge
   fit against ADRs, project direction, adjacent patterns, lifecycle,
   reversibility, and operational constraints. Reject taste-based redesigns.
1C. FINANCIAL & STRATEGY VALIDITY — for monetary, trading, forecasting,
   optimization, allocation, or risk changes, check accounting identities,
   research falsifiability, implementation realism, aggregate containment, and
   whether the decision remains valid under costs, uncertainty, and stress.
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
7. DOCUMENTATION SELF-CONTAINMENT — for any prose doc in the diff (ADRs,
   READMEs, design docs, SPEC), check it reads as a standalone record a future
   reader understands without the PR, the review threads, the chat, or the code
   in front of them. Flag passages that: reference an artifact the reader
   cannot see in the doc ("the implementation comment", "the reviewer said",
   "as noted above" with nothing above, an unquoted code comment); narrate the
   authoring/review/delivery process ("a re-review found", "added in this PR",
   "this stack", "already shipped in #N", "stacked below", "slice(s)") instead
   of stating the decision; argue against an external position ("this is NOT
   the benign X that Y claims") instead of stating the fact directly; carry a
   dangling cross-reference (an ADR number, section, or PR that does not
   resolve or contradicts the doc's own numbering); or use a term as if defined
   when it never was. These examples are illustrative of the class — apply the
   principle, do not pattern-match the phrases. Scope: prose docs actually in
   the diff (this is not the "missing documentation" case below).

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
| security | convention | maintainability | tests | doc-coherence |
architecture | financial | strategy | risk), finding
(one-paragraph description), why_it_matters (concrete consequence if not
fixed), recommended_fix (specific and actionable — not "consider doing X"),
and confidence (0-100; 100 = certain, 50 = plausible but unverified, 25 =
hunch).

If you find nothing worth raising, return an empty findings list and set
clean_reason to a one-sentence justification of why the diff is clean.
```

(For the optional Claude Code subscription lane, replace the "Output"
paragraph with the original markdown output format: `### <title>` sections with
Severity/File/Category/Finding/Why it matters/Recommended fix/Confidence
bullets, and `### No findings` when clean. Its prompt must be self-contained
because the external CLI reads no other prompt files.)

### Per-reviewer focus paragraphs

Append one of these to the base prompt for each reviewer:

**Opus A — Concurrency & async ordering:**
```
YOUR FOCUS: Pay special attention to the ordering of async operations
during setup, teardown, and reconnection. When two async steps happen in
sequence (subscribe then query, or query then subscribe), consider what
happens if the world changes between them. Look for TOCTOU gaps in async
setup sequences, concurrent writers to shared state, and assumptions about
which operation completes first.
```

**Fable — Goal evaluation & domain logic:**
```
YOUR FOCUS: Read the description carefully, then evaluate whether the
implementation actually achieves what it claims. If it says "events are
never lost," find a scenario where they could be. If it says "checkpoint
only advances safely," find a case where it doesn't. Be adversarial about
the stated goals — your job is to find the gap between intent and
implementation.
```

**Sonnet — Error handling & failure modes:**
```
YOUR FOCUS: Trace every error path and failure mode. What happens when a
database write fails mid-operation? When a background job exhausts its
retries? When a network call times out during a multi-step process? Look
for silent failures, missing error propagation, and recovery paths that
leave the system in an inconsistent state.
```

**External A — Edge cases & boundary conditions:**
```
YOUR FOCUS: Look for edge cases at boundaries. What happens at block 0?
When a range is empty? When both inputs are equal? When an optional value
is None for the first time? When a counter overflows? Find the inputs
that the author probably didn't test.
```

**External B — Broad general sweep:**
```
YOUR FOCUS: Do a broad, unbiased review. Don't focus on any particular
category — instead, try to find anything the other reviewers might miss.
Look at the change holistically: does the overall design make sense? Are
there interactions between components that could produce surprising
behavior? Are there implicit assumptions that aren't documented?
```

## 3. Build the inspector prompts (selected by what the scope contains)

**Inspectors are context-driven — include only the ones that match the code in
the scope.** Running the Rust inspector on a TypeScript change (or all 16 on a
one-language repo) wastes lanes. Decide the set from `{FILES_PATH}` extensions
plus two content sniffs of the diff (`grep` the diff for `from "effect"` and for
`solid-js`). Inspectors are cheap, so when a language is present, include its
inspector; the functional-programming inspector rides along with any FP-leaning
source. Higher-level and financial inspectors (defensive-programming,
architecture-direction, financial-programming, quantitative-research,
quantitative-trading, risk-management) are domain-driven, not
extension-driven — include each when the diff content matches its "include
when" row, judged from the diff itself.

Select the smallest complete set, not every possible lane. A single diff may
need several complementary domain inspectors (for example deterministic
accounting reconciliation + empirical strategy validity + live execution +
risk containment), but do not add a lane whose trigger is absent. For an audit,
include every matching higher-level lane because the synthetic diff places the
whole scoped system in review.

| Inspector | Skill (under `~/.claude/skills/`) | Include when the scope has | Lane model | Category / severity mapping |
| --- | --- | --- | --- | --- |
| test | `test-inspector` | test files | sonnet | category `tests`; useless=medium, weak=low, missing-coverage-for-risky=high, mock-abuse=medium |
| rust | `idiomatic-rust-inspector` | `.rs` | opus | `maintainability` for idiom, `correctness` for ownership/unsafe; non-idiomatic-with-correctness-impact=high, style-only=medium, suboptimal=low |
| typescript | `idiomatic-typescript-inspector` | `.ts` / `.tsx` | sonnet | `maintainability` (or `correctness` when an `any`/unsafe cast hides a bug); same scale as rust |
| effect | `idiomatic-effect-inspector` | a TS file importing `effect` | opus | `maintainability`/`correctness`; throwing or an untyped error channel = high |
| nushell | `idiomatic-nushell-inspector` | `.nu` | sonnet | `maintainability`; `complete` on an internal command or data-loss from string-parsing = high |
| nix | `idiomatic-nix-inspector` | `.nix` | opus | `maintainability`; import-from-derivation / impurity / non-reproducibility = high |
| solidjs | `idiomatic-solidjs-inspector` | `solid-js` used | sonnet | `maintainability`; reactivity-breaking (prop destructure, effect-for-derived) = high |
| svelte | `idiomatic-svelte-inspector` | `.svelte` | sonnet | `maintainability`; reactivity bugs (effect-for-derived, legacy runes) = high |
| github-actions | `idiomatic-github-actions-inspector` | files under `.github/workflows/` | opus | `security` for unpinned actions / script injection / over-broad permissions (high..critical); else `maintainability` |
| terraform | `idiomatic-terraform-inspector` | `.tf` | opus | `security` for plaintext secrets = critical; `maintainability` for count-vs-for_each / structure |
| functional-programming | `idiomatic-functional-programming-inspector` | any FP-leaning source (`.rs`/`.ts`/`.tsx`/`.nu`/`.nix`) | sonnet | `maintainability`; side-effects-in-transforms / partial functions / invalid-states-representable = high |
| strong-typing | `strong-typing-inspector` | any typed source (`.rs`/`.ts`/`.tsx`) | sonnet | `maintainability`; primitive-where-domain-type-exists = medium (high for money/identifiers), missed-newtype = low |
| external-contract | `external-contract-inspector` | external touchpoints (HTTP/RPC/SDK responses, on-chain ABIs, units/decimals) — usually worth including | opus | `correctness`; risk-weighted critical (wrong width/unit/encoding at a money or on-chain boundary) down to low |
| defensive-programming | `defensive-programming-inspector` | stateful flows, persistence/recovery, accounting or conservation equations, aggregate/projection derivation, or the same domain state shown through multiple views | opus | `correctness` or `financial`; unreconciled money/whole-book state=critical, deterministic cross-view/state divergence=high, bounded malformed-state acceptance=medium |
| architecture-direction | `architecture-direction-inspector` | dependency manifests, subsystem/module/public boundaries, source-of-truth ownership, persistence/transport/deployment changes, migrations, or a new major capability | opus | `architecture`; irreversible wrong ownership/dependency direction=high..critical, evidenced recurring coupling/glue=medium, bounded refinement=low |
| financial-programming | `financial-programming-inspector` | monetary values, balances, prices, fees, ledger entries, token math, equity/NAV, cash flows, or monetary projections | opus | `financial`; silent value corruption or accounting-identity failure=critical, wrong rounding/conservation/cross-ledger mismatch=high, precision drift=medium |
| quantitative-research | `quantitative-research-inspector` | strategy/signal research, forecasting, backtests, optimization, portfolio/project/provider allocation, pacing/burn-rate models, or statistical decision rules | opus | `strategy` or `financial`; leakage/invalid evidence sizing live decisions=critical, selection bias/regime/cost failure=high, uncertainty/calibration gap=medium |
| quantitative-trading | `quantitative-trading-inspector` | trading implementation (orders, fills, positions, market data, executable signals, backtests) | opus | `strategy` or `correctness`; position/PnL desync or sign errors=critical, unavailable information/stale-price/venue violations=high, research-only execution-model gap=medium |
| risk-management | `risk-management-inspector` | automated money paths, aggregate exposure, position sizing, payment dispatch, leverage/concentration, liquidity/capacity, drawdown, or stress controls | opus | `risk` or `security`; unbounded/fail-open/double-send paths=critical, aggregate/concentration/stress/model-uncertainty gaps=high, silent breach handling=medium |

Higher-level trigger checks are explicit:

- Stateful persistence, recovery, aggregate, accounting, or multi-view changes
  with a conservation/reconciliation identity select
  `defensive-programming-inspector`.
- Dependency, source-of-truth, subsystem/public-boundary, migration,
  persistence/transport, or deployment direction changes select
  `architecture-direction-inspector`.
- Forecast, signal, strategy, backtest, optimizer, allocation, or pacing-model
  changes select `quantitative-research-inspector`.

Every inspector lane uses `openai-codex/gpt-5.6-luna` under the provider
constraint. Inspector lanes never invoke a retired external harness.

For each **selected** inspector, write `$out_dir/prompt-<inspector>.txt` =
the full body of its skill file (everything below the frontmatter, with
`$ARGUMENTS` replaced by `{INSPECTOR_ARG}`) + the shared context block below +
its mapping rule from the table (tell it to return findings via the structured
output tool, and to return an empty findings list with `clean_reason` if its
language is not actually present once it reads the diff).

Shared context block (append to every inspector prompt):

```
The diff is at: {DIFF_PATH}
Repo root: {REPO_ROOT}
{SOURCE_ACCESS}
```

## 4. Assemble the lanes

Build native reviewer lanes for the required focus prompts plus every selected
inspector. Each native lane object is `{key, model, promptPath, diffPath}` and
sets `model` to `openai-codex/gpt-5.6-luna`. Normally all lanes share
`{DIFF_PATH}`; chunked runs differ as described below.

When available, add at most one read-only Claude Code subscription lane using
the exact command in the provider constraint. Its lane object uses
`{key, externalCmd, promptPath, diffPath}` and omits `model`. Never replace it
with an Anthropic API provider or a retired Cursor executable.

### Adaptive panel sizing (by diff size)

Size the native panel to the diff so each pass stays affordable. Inspectors
selected in step 3 are always included.

- **< 50 changed lines:** goal-evaluation and error-handling focus lanes, selected
  inspectors, and the optional Claude subscription lane.
- **50-500 changed lines:** all native focus lanes, selected inspectors, and the
  optional Claude subscription lane.
- **> 500 lines or security-sensitive paths:** all native focus lanes, every
  applicable inspector, and the optional Claude subscription lane.

Security-sensitive paths force the full panel regardless of size. Drop lanes by
omitting their objects from the `lanes` array.

### Chunk splitting for large diffs

If the diff exceeds **3,500 lines**, the caller splits it into domain-based
chunks (each under ~3,500 lines) so each reviewer stays in quality range.
**Chunk diff generation is the caller's job** — it depends on how the diff was
obtained (`git diff <parent> -- <paths>` for a local branch; a different slice
for a not-checked-out PR) and the engine never produces diffs. The engine only
consumes whatever `lanes` it receives, so chunking is "the caller builds more
lane objects":

1. Read `{FILES_PATH}` to see which files changed.
2. Group files by domain/crate/directory into logical chunks; verify all files
   are covered; report chunk sizes to the user.
3. Duplicate the reviewer lanes per chunk (keys like `opus-a-chunk-b`), each
   with its chunk's `diffPath`. Inspector lanes run once on the full diff.
4. Pass all lanes to a single workflow invocation — dedup and verification
   handle the rest.

Skip chunking for diffs under 3,500 lines, single-directory diffs, or when the
user asks for a single-pass review.

## 5. Run the review-panel workflow

The whole pass — fan-out, dedup, adversarial verification, synthesis — runs as
**one `Workflow` invocation**. Findings come back schema-validated, so there is
no markdown parsing and no separate aggregator in the main session.

Invoke `Workflow` with the script below via `script`, and `args`. Set
`maxAgents: 16`; this is a per-named-phase cap, while `tokenBudget` remains a
whole-workflow cap. The script batches larger lane or finding sets into settled
named phases, retaining each completed batch in the same invocation before
synthesis:

```json
{
  "repoRoot": "{REPO_ROOT}",
  "docsPaths": ["{PROJECT_DOCS_PATHS as array}"],
  "lanes": [ ...lane objects — every lane.model must match harness_tier... ],
  "harnessModels": { "verify": "openai-codex/gpt-5.6-luna", "synthesis": "openai-codex/gpt-5.6-luna" },
  "reportHeader": "{REPORT_HEADER}",
  "synthesisExtra": "{SYNTHESIS_EXTRA}",
  "sourceAccess": "{SOURCE_ACCESS}",
  "sourceRevision": "{SOURCE_REVISION}",
  "includeAttribution": {INCLUDE_ATTRIBUTION}
}
```

`harnessModels` comes from step 1d. **`native-only` / `sonnet-only`:** both
`verify` and `synthesis` must be `"sonnet"`. **`full` harness:** synthesis may
be `"opus"`. Never pass `"opus"` or `"fable"` anywhere when the cache says
`sonnet-only`.

The tool result includes a `scriptPath` — the caller keeps it and reuses
`{scriptPath, args}` for any later full-panel pass instead of resending the
script.

When `{SOURCE_REVISION}` is present, native lanes receive Bash solely for exact
read-only `git show '<revision>:<repo-relative-path>'` calls. Never read `.env*`,
credential stores, private keys, or certificates. The revision is validated
before Bash is exposed; checkout, worktree creation, mutation, and unrelated
shell commands remain prohibited and semantically classified.

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
    category: { enum: ['correctness', 'security', 'convention', 'maintainability', 'tests', 'doc-coherence', 'architecture', 'financial', 'strategy', 'risk'] },
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
const { repoRoot, docsPaths, lanes, reportHeader, synthesisExtra,
  sourceAccess, sourceRevision, includeAttribution,
  harnessModels = { verify: 'sonnet', synthesis: 'opus' } } = parsedArgs

const gitObjectSource = typeof sourceRevision === 'string' &&
  /^[0-9a-f]{40,64}$/.test(sourceRevision)
if (sourceRevision !== undefined && !gitObjectSource) {
  throw new Error('sourceRevision must be an exact lowercase hexadecimal Git object ID')
}
const sourceTools = gitObjectSource
  ? ['read', 'grep', 'find', 'ls', 'bash']
  : ['read', 'grep', 'find', 'ls']
const sourceReadBoundary = gitObjectSource
  ? `For PR-head source context, use Bash only for exact read-only ` +
    `git show '${sourceRevision}:<repo-relative-path>' calls. Do not use the ` +
    `mismatched working-tree copy of a source file. Never read \`.env*\`, ` +
    `credential stores, private keys, or certificates. Do not use Bash for ` +
    `checkout, worktree creation, mutation, or unrelated commands.`
  : ''

// maxAgents is a per-phase cap. Batch variable lane/finding counts so one
// workflow retains completed outputs through verification and synthesis.
const PHASE_AGENT_CAP = 16

const reviewLane = lane => {
  const context = `The diff is at: ${lane.diffPath}\n` +
    `Project docs: ${docsPaths.join(', ')}\n` +
    `Repo root: ${repoRoot}`

  const prompt = lane.externalCmd
    ? `Use Bash to run external review commands from the directory ${repoRoot} ` +
      `(one call per command, 10 minute timeout each).\n\n` +
      `Primary command:\n${lane.externalCmd}\n\n` +
      (lane.fallbackCmds?.length
        ? `If the primary fails with usage limit, rate limit, quota, auth, or ` +
          `timeout errors, try these fallbacks IN ORDER (one Bash call each):\n` +
          lane.fallbackCmds.map((cmd, i) => `${i + 1}. ${cmd}`).join('\n') +
          `\n\nIf every external command fails, read the review instructions at ` +
          `${lane.promptPath} and follow them as a native sonnet reviewer ` +
          `(standard structured output — not markdown sections).\n`
        : `If the command fails, reports a usage/rate limit, or is unusable, ` +
          `read the review instructions at ${lane.promptPath} and follow them ` +
          `as a native sonnet reviewer instead.\n`) +
      `Otherwise convert the review stdout into structured findings (parse each ` +
      `### section into one finding). If all attempts fail, return an empty ` +
      `findings list and set reviewer_error to a summary of each attempt.`
    : `Read the review instructions at ${lane.promptPath} and follow them ` +
      `exactly.\n${context}\n${sourceReadBoundary}\nRead the diff, the project ` +
      `docs, and any source files referenced by the diff that you need for context.`

  return agent(prompt, {
    label: `review:${lane.key}`,
    phase: 'Review',
    cwd: repoRoot,
    tools: lane.externalCmd
      ? ['read', 'grep', 'find', 'ls', 'bash']
      : sourceTools,
    model: 'openai-codex/gpt-5.6-luna',
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
}

const laneResults = []
const reviewBatchCount = Math.max(1, Math.ceil(lanes.length / PHASE_AGENT_CAP))
for (let offset = 0; offset < lanes.length; offset += PHASE_AGENT_CAP) {
  const batchNumber = Math.floor(offset / PHASE_AGENT_CAP) + 1
  phase(`Review ${batchNumber}/${reviewBatchCount}`)
  laneResults.push(...await parallel(
    lanes.slice(offset, offset + PHASE_AGENT_CAP).map(lane => () => reviewLane(lane)),
  ))
}

const laneErrors = lanes
  .map((lane, index) => {
    const result = laneResults[index]
    if (!result) return `${lane.key}: lane died or was skipped`
    if (result.error) return `${lane.key}: ${result.error}`
    return null
  })
  .filter(Boolean)

const raw = laneResults.filter(Boolean).flatMap(result => result.findings)

// Dedup across ALL lanes before the expensive verify phase — this barrier is
// intentional (it removes duplicate work), not an accident to "parallelize away".
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

const verifyFinding = finding => agent(
    `You are adversarially verifying a single code-review finding. Read the ` +
    `actual code before judging — never judge from the finding text alone.\n\n` +
    `Finding: ${JSON.stringify(finding)}\n\n` +
    `The diff is at: ${finding.diff_path}\nRepo root: ${repoRoot}\n` +
    `${sourceAccess}\n${sourceReadBoundary}\n\n` +
    `Classify the finding: valid (real, you verified it against the code), ` +
    `likely (probably real but needs more context), disputed (evidence is ` +
    `weak), invalid (false positive — the code contradicts the claim), ` +
    `out-of-scope (real but on lines the diff did not modify). Refute only ` +
    `with concrete evidence from the code; do not dismiss ` +
    `uncertain-but-plausible findings. For architecture, financial, strategy, ` +
    `and risk findings, inspect the cited ADR/spec/invariant/research evidence ` +
    `and the end-to-end path; do not dismiss them merely because the changed ` +
    `line is locally valid. Re-score severity and confidence from your own ` +
    `reading (confidence 100 = you verified it yourself).`,
    { label: `verify:${finding.file}`, phase: 'Verify', cwd: repoRoot,
      tools: sourceTools, model: 'openai-codex/gpt-5.6-luna',
      schema: VERDICT_SCHEMA },
  ).then(verdict => verdict && ({ ...finding, ...verdict }))

const verified = []
const verifyBatchCount = Math.max(1, Math.ceil(merged.length / PHASE_AGENT_CAP))
for (let offset = 0; offset < merged.length; offset += PHASE_AGENT_CAP) {
  const batchNumber = Math.floor(offset / PHASE_AGENT_CAP) + 1
  phase(`Verify ${batchNumber}/${verifyBatchCount}`)
  verified.push(...await parallel(
    merged.slice(offset, offset + PHASE_AGENT_CAP)
      .map(finding => () => verifyFinding(finding)),
  ))
}

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

const foundByField = includeAttribution ? 'Found by, ' : ''
const synthesis = await agent(
  `You are a senior staff engineer writing the canonical report for a ` +
  `multi-reviewer code review. The findings below were already deduplicated ` +
  `and adversarially verified — do not re-litigate verdicts.\n\n` +
  `Report header (use verbatim at the top):\n${reportHeader}\n\n` +
  `Reviewer lanes that errored: ${JSON.stringify(laneErrors)}\n\n` +
  `Verified findings (JSON, pre-sorted): ${JSON.stringify(survivors)}\n\n` +
  `Dismissed findings (JSON): ${JSON.stringify(dismissed)}\n\n` +
  `The diff is at: ${lanes[0].diffPath}. Project docs: ` +
  `${docsPaths.join(', ')}. ${sourceAccess} ${sourceReadBoundary} Read the diff so your overall ` +
  `assessment reflects the actual change, and call out anything the ` +
  `reviewers collectively missed. Preserve verified architectural and ` +
  `strategic findings as first-class recommendations: retain their cited ` +
  `project direction, invariant or hypothesis, migration/falsification ` +
  `boundary, and concrete consequence rather than flattening them into ` +
  `maintainability prose.\n\n` +
  `Produce a markdown report: the header block, "## Summary" (2-3 sentence ` +
  `verdict with valid-finding counts per severity), "## Findings" (one ` +
  `"### [SEVERITY] <title>" section per finding with File, Category, ` +
  `Validity, Confidence, ${foundByField}Issue, Why it matters, Recommended ` +
  `fix, and the verifier's rationale as "Verification"), "## Findings ` +
  `dismissed as invalid" (bulleted, one-line rationale each), "## Findings ` +
  `dismissed as out-of-scope", "## Overall assessment" (2-3 paragraphs of ` +
  `your own senior-engineer judgment on merge readiness). No emojis, no ` +
  `apologies, be decisive.` +
  (synthesisExtra ? `\n\n${synthesisExtra}` : ''),
  { label: 'synthesize', phase: 'Synthesize', cwd: repoRoot,
    tools: sourceTools, model: 'openai-codex/gpt-5.6-luna',
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

## 6. After the workflow returns

The workflow returns `{findings, dismissed, laneErrors, report}`.

1. Write `report` to `$out_dir/review.md` and the findings JSON to
   `$out_dir/findings.json` (audit trail). `findings.json` keeps the `found_by`
   attribution even when `{INCLUDE_ATTRIBUTION}` is false — only `review.md` and
   the terminal output drop it.
2. If `laneErrors` is non-empty, tell the user which lanes errored. If **all
   reviewer lanes** errored, stop. Inspector lanes erroring is non-fatal.
3. If `findings` is empty, the pass is clean.

## 7. Print findings to the terminal

Print a compact, scannable summary from the returned `findings`. Show the
`[lanes]` bracket only when `{INCLUDE_ATTRIBUTION}` is true:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
{TERMINAL_HEADER}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

▲ CRITICAL (count)
  1. <title>
     <file>:<line>  [opus-a, external-b]  confidence: 95
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

Keep each finding to **two lines**: title line (title + lanes + confidence) and
fix line (recommended fix). Full details live in `review.md`. The caller decides
what happens when there are no findings and what to do next.

## Engine failure modes

- **All reviewer lanes error:** stop only if every native
  `openai-codex/gpt-5.6-luna` Workflow lane failed. An optional Claude lane
  failure is never fatal.
- **The workflow itself fails mid-run:** relaunch with `{scriptPath, args,
  resumeFromRunId}` — completed lanes return cached results instantly; only the
  failed part re-runs.
- **The Claude subscription lane hits a usage limit:** omit it and continue the
  native Workflow panel; never fall back to an API provider or Cursor.

## Hard rules

1. The review pass runs as a **single `Workflow` invocation** — never run
   reviewers sequentially or hand-roll the fan-out with individual Agent calls.
2. Verification and synthesis happen **inside the workflow**, never in the main
   session (context pollution).
3. **The optional Claude subscription CLI runs read-only** with
   `--permission-mode plan`; never use an Anthropic API provider.
4. Never fabricate findings when a lane errors — record the failure from
   `laneErrors`.
5. The Review→Verify and Verify→Synthesize barriers are **intentional** (dedup
   needs all lanes; synthesis needs all survivors). Within each phase everything
   runs in parallel; do not collapse the phases.
6. Save `review.md` and `findings.json` to `$out_dir` before printing to the
   terminal.
