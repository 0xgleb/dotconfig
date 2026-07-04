---
name: review-core
description: Internal shared review-engine reference for the review-loop, review-pr, and review-sweep skills. Not a user task and never invoked directly; those skills read this file to run the multi-model panel, probes, prompts, and finding output.
allowed-tools: Bash(cursor-agent:*), Bash(agy:*), Bash(command:*), Bash(cat:*), Bash(find:*), Bash(mkdir:*), Bash(wc:*), Read, Write, Agent, Workflow
---

# Review engine (shared)

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
| `{SCOPE_NOTE}`      | One sentence describing **what the diff is scoped to** (branch vs PR).     |
| `{INSPECTOR_ARG}`   | The value to substitute for `$ARGUMENTS` in inspector bodies (`""` for a branch, the PR ref for a PR). |
| `{REPORT_HEADER}`   | Markdown header block placed verbatim atop the synthesized report.         |
| `{TERMINAL_HEADER}` | The boxed header line(s) for the terminal summary (step 7).                |
| `{SYNTHESIS_EXTRA}` | Extra synthesis instructions, or `""`. PR review passes the no-AI-references / frame-to-reviewer block. |
| `{INCLUDE_ATTRIBUTION}` | `true` to keep `Found by` lane attribution in the report and terminal output; `false` to strip it (PR review). |

## 1. Resolve panel mode (limits-aware — never block the review)

External CLIs (`cursor-agent`, `agy`) are **optional enrichments**. The Workflow
**always** runs, but **Harness models (Opus/Sonnet) share the same Cursor usage
pools** as cursor-agent — on limit-blown days Opus is often out too. When that
happens, set `harness_tier=sonnet-only` so every Workflow phase uses **sonnet**
(review, verify, synthesis, inspectors). `/review-pr` must still complete.

Two independent axes:

| Axis | Values | Controls |
| ---- | ------ | -------- |
| `panel_mode` | `full` / `degraded-fast` / `native-only` | External CLIs (cursor-agent) |
| `harness_tier` | `full` / `sonnet-only` | Workflow `model:` for Fable/Opus lanes, synthesis, opus inspectors |

**Rule:** `panel_mode=native-only` **always** implies `harness_tier=sonnet-only`.
When composer sentinel fails, assume Opus is out too — do not probe Opus separately.

Three panel modes:

| Mode            | When                         | External CLIs | Harness |
| --------------- | ---------------------------- | ------------- | ------- |
| `full`          | Both sentinels pass          | frontier + composer augment | fable/opus where configured |
| `degraded-fast` | Frontier out, composer OK    | composer only | fable/opus where configured |
| `native-only`   | Composer out (or cache)      | **none**      | **sonnet-only** |

### 1a. Read the session cache (do this first)

```bash
cache="$HOME/.config/.tmp/claude-local-ctx/review-panel-cache.json"
mkdir -p "$(dirname "$cache")"
```

If the file exists and `mode` is `native-only` and `cached_at` is within the
last **4 hours**, set `panel_mode=native-only` and `harness_tier=sonnet-only`
and **skip all probes**. Tell the user: "Panel: native-only, harness: sonnet
(limit-blown day — cached)."

To force a re-probe (e.g. after billing reset): delete the cache file.

### 1b. Sentinel probes (only when cache miss — max TWO calls)

**Do NOT walk the full model chain on every invoke.** That burns minutes on
limit-blown days and blocks `/review-pr` before the Workflow starts.

Run **at most two** one-token probes, **15 seconds each**, one Bash call each.
A probe **fails** on non-zero exit, timeout, or output matching "usage limit",
"rate limit", "quota", or "limit reached" (case-insensitive).

```bash
# Sentinel 1 — fast tier (decisive for limit-blown days)
cursor-agent -p --mode plan --model composer-2.5 --trust "Reply with exactly: OK"

# Sentinel 2 — only if sentinel 1 passed; skip agy entirely on limit days
cursor-agent -p --mode plan --model gpt-5.5-high --trust "Reply with exactly: OK"
```

**Decision table** (apply immediately — do not run more probes):

| Sentinel 1 (composer) | Sentinel 2 (gpt-5.5) | panel_mode      | Action |
| --------------------- | -------------------- | --------------- | ------ |
| usage limit / fail    | (skip)               | `native-only`   | Write cache; **never probe agy or other models** |
| OK                    | usage limit / fail   | `degraded-fast` | external-a/b = composer-2.5 + composer-2.5-fast or auto |
| OK                    | OK                   | `full`          | external-a/b = gpt-5.5-high; composer augment = composer-2.5 |
| not on PATH           | —                    | `native-only`   | cursor-agent missing |

When `panel_mode=native-only`, write the cache with both axes:

```json
{"mode":"native-only","harness_tier":"sonnet-only","cached_at":"<ISO8601>","reason":"composer sentinel: usage limit"}
```

Tell the user which mode landed. **Proceed to step 2 immediately** — limits
are never a reason to stop.

### 1c. Optional upgrade probes (full mode only, never required)

Only when sentinel 2 passed **and** the diff is large enough to justify extra
frontier capacity, you *may* try cheaper frontier models **one at a time** until
one passes or all fail — then stay on `gpt-5.5-high` from sentinel 2:

`gpt-5.4-high`, `gpt-5.3-codex-high`, `gemini-3.1-pro`

**Never run these on a cache hit, in native-only mode, or when sentinel 2 already
failed.** Never run `agy` when any cursor-agent probe returned usage limit (agy
hangs and shares the same billing reality). Skip `agy` entirely unless the user
explicitly asks for it.

### 1d. Lane assignment by panel_mode

Record `harness_tier` and `harnessModels` for the Workflow args (step 5):

```json
{ "verify": "sonnet", "synthesis": "opus" }
```

When `harness_tier=sonnet-only`, use `{ "verify": "sonnet", "synthesis": "sonnet" }`
for **every** Workflow agent call — review lanes, verify, synthesis. Never pass
`fable` or `opus` to the Workflow on a limit-blown day.

**Reviewer lanes** — keys keep their focus prompts; **model** follows harness:

| key        | promptPath            | model (full harness) | model (sonnet-only) |
| ---------- | --------------------- | -------------------- | ------------------- |
| opus-a     | prompt-opus-a.txt     | opus                 | sonnet              |
| fable      | prompt-fable.txt      | fable                | sonnet              |
| sonnet     | prompt-sonnet.txt     | sonnet               | sonnet              |
| external-a | prompt-external-a.txt | see below            | sonnet              |
| external-b | prompt-external-b.txt | see below            | sonnet              |

**Fable budget — at most ONE fable agent per panel:** the `fable` reviewer
lane, nothing else. Synthesis, verify, inspector, and external lanes never run
on fable — they keep their table/harness defaults (synthesis: opus on a full
harness, else sonnet). Fable burns usage limits far faster than sonnet; the
budget is a hard cap, not a tuning suggestion. Watch the implicit path: a
Workflow agent with no `model` inherits the SESSION model (fable when the main
loop runs Fable) — the panel script therefore defaults model-less lanes to
sonnet (`model: lane.model ?? 'sonnet'`); never remove that default.

**native-only** (`panel_mode=native-only`, `harness_tier=sonnet-only`): all five
rows use **sonnet**, no `externalCmd`, no `composer` lane. Inspectors: override
every inspector lane to **sonnet** (ignore the opus defaults in the step-3 table).

**degraded-fast** — composer as external (omit `composer` augment):

| key         | externalCmd model   |
| ----------- | ------------------- |
| external-a  | cursor-agent `composer-2.5` |
| external-b  | cursor-agent `composer-2.5-fast` or `auto` |

**full** — frontier + augment:

| key         | externalCmd model   |
| ----------- | ------------------- |
| external-a  | cursor-agent `gpt-5.5-high` (or upgrade-winner) |
| external-b  | cursor-agent `gpt-5.5-high` (or upgrade-winner) |
| composer    | cursor-agent `composer-2.5` |

### 1e. Mid-run exhaustion (external modes only)

When `panel_mode` is not `native-only`, external lanes may hit limits mid-panel.
Each external lane carries `fallbackCmds` as before.

**If any Workflow lane errors with a Fable/Opus usage limit** (even in `full` mode):
1. Set `harness_tier=sonnet-only`, update cache, relaunch Workflow with
   `{scriptPath, args}` — every lane model and `harnessModels.synthesis` → sonnet.
2. Do **not** stop `/review-pr`. The relaunch is the recovery path.

When `harness_tier=sonnet-only`, no lane may use `model: 'fable'` or `model: 'opus'`.

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
| security | convention | maintainability | tests | doc-coherence), finding
(one-paragraph description), why_it_matters (concrete consequence if not
fixed), recommended_fix (specific and actionable — not "consider doing X"),
and confidence (0-100; 100 = certain, 50 = plausible but unverified, 25 =
hunch).

If you find nothing worth raising, return an empty findings list and set
clean_reason to a one-sentence justification of why the diff is clean.
```

(For external lanes that run through an external CLI — cursor-agent or agy —
replace the "Output" paragraph in their prompt files with the original markdown
output format — `### <title>` sections with Severity/File/Category/Finding/Why
it matters/Recommended fix/Confidence bullets, "### No findings" when clean —
since the external CLI returns text that the lane agent converts to structured
output. Their prompt files must be self-contained: the external CLI reads no
other prompt files, so inline the full review instructions and note that the
diff path is appended to the prompt. If an external lane fell back to a **native
sonnet lane** on the probes, keep the standard structured-output paragraph.)

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
the scope.** Running the Rust inspector on a TypeScript change (or all 13 on a
one-language repo) wastes lanes. Decide the set from `{FILES_PATH}` extensions
plus two content sniffs of the diff (`grep` the diff for `from "effect"` and for
`solid-js`). Inspectors are cheap, so when a language is present, include its
inspector; the functional-programming inspector rides along with any FP-leaning
source.

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

**Harness override:** when `harness_tier=sonnet-only`, set **every** inspector lane
model to `sonnet` regardless of the table above. Inspector lanes never run on
`fable` under any tier (see the Fable budget in step 1d).

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

Build the lane list from `panel_mode` (step 1). **native-only**: five native
reviewer lanes, no `externalCmd`, no `composer` lane. **degraded-fast** / **full**:
add external lanes per step 1d.

| key                | external | model  | promptPath                              |
| ------------------ | -------- | ------ | --------------------------------------- |
| opus-a             | no       | opus   | prompt-opus-a.txt (concurrency)         |
| fable              | no       | fable  | prompt-fable.txt (goal evaluation)      |
| sonnet             | no       | sonnet | prompt-sonnet.txt (error handling)      |
| external-a         | if ext   | sonnet or — | prompt-external-a.txt (edge cases) |
| external-b         | if ext   | sonnet or — | prompt-external-b.txt (broad sweep) |
| composer           | yes      | —      | prompt-composer.txt (**full mode only**) |
| inspectors         | no       | per step 3 | one lane per inspector SELECTED in step 3 |

The composer lane reuses the Sonnet focus paragraph (error handling & failure
modes) in the external-CLI prompt format — same coverage, different lab.

Each lane object: `{key, externalCmd, fallbackCmds, model, promptPath, diffPath}`.
Normally all lanes share `{DIFF_PATH}`; chunked runs differ (see "Chunk splitting").
Omit `fallbackCmds` (or `[]`) on native lanes. External lanes MUST populate
`fallbackCmds` per step 1.

For external lanes running through an external CLI, set `externalCmd` to the
**complete shell command** (with the lane's own prompt and diff paths
substituted) and omit `model`:

- cursor-agent lanes (`gpt-5.5-high`, `composer-2.5`, `auto`, or any model from
  the probe chains):
  ```
  cursor-agent -p --mode plan --model <lane-model> --trust --workspace "{REPO_ROOT}" "$(cat "<promptPath>") The diff to review is at: <diffPath>"
  ```
- agy (Antigravity CLI) lanes:
  ```
  agy -p "$(cat "<promptPath>") The diff to review is at: <diffPath>" --sandbox
  ```
  Run from `{REPO_ROOT}` as cwd (agy has no `--workspace` flag; the workspace is
  the working directory, and the diff lives under it). The command omits
  `--model`, so agy uses its default. To make this lane truly frontier-tier,
  sign in once (`agy`), run `agy models`, and pin a strong Gemini model by adding
  `--model <id>` here — this is the **single** place to change it for all three
  review skills.

For native lanes (including an external lane that fell back to native sonnet),
leave `externalCmd` unset and set `model` as usual.

**External CLIs run read-only — non-negotiable.** cursor-agent: always `--mode
plan`, never `-f`/`--yolo`, never bare `-p` without a read-only mode (headless
print mode otherwise has write and shell access); `-w` is `--worktree`, NOT
`--workspace` — always spell out `--workspace`. agy: always `--sandbox` and
**NEVER `--dangerously-skip-permissions`** (that auto-approves every tool,
including writes and shell). Use `-p` for the one-shot prompt. Without
skip-permissions agy cannot perform approval-gated mutations unattended, and
`--sandbox` confines tool execution with terminal restrictions — together the
read-only equivalent of plan mode. If a signed-in agy still blocks the file
reads it needs to review the diff, set the `strict` tool-permission preset in
agy's config (read tools allowed, everything else blocked) rather than relaxing
to skip-permissions.

### Adaptive panel sizing (by diff size)

Size the panel to the diff so each pass stays affordable (this matters most when
a caller re-runs the panel). Inspectors are always included — they are cheap
(9–18s each):

- **< 50 changed lines:** `fable` (goal eval) + one external broad-sweep lane +
  all four inspectors. ~6 lanes.
- **50–500 lines:** the full catalogue minus one redundant lane (`external-a`
  and `external-b` overlap heavily — drop one; or drop the `composer` augment if
  both frontier lanes are live). ~8 lanes.
- **> 500 lines, or any diff touching security-sensitive paths** (auth, secrets,
  payment/financial, on-chain, migrations): the full catalogue.

Security-sensitive paths force the full panel regardless of size. When in doubt,
size up. Drop lanes by omitting their objects from the `lanes` array — the script
rebuilds the panel from whatever lanes it receives.

**Degraded / native-only sizing:** when `panel_mode` is `native-only` or
`degraded-fast`, drop the `composer` augment (already omitted in native-only).
For whole-repo audits in native-only mode, **batch** workflow passes (~40 lanes
each). For `/review-pr` and normal branch reviews, one pass is fine — five native
reviewers + inspectors is the designed limit-blown panel.

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

Invoke `Workflow` with the script below via `script`, and `args`:

```json
{
  "repoRoot": "{REPO_ROOT}",
  "docsPaths": ["{PROJECT_DOCS_PATHS as array}"],
  "lanes": [ ...lane objects — every lane.model must match harness_tier... ],
  "harnessModels": { "verify": "sonnet", "synthesis": "sonnet" },
  "reportHeader": "{REPORT_HEADER}",
  "synthesisExtra": "{SYNTHESIS_EXTRA}",
  "sourceAccess": "{SOURCE_ACCESS}",
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
    category: { enum: ['correctness', 'security', 'convention', 'maintainability', 'tests', 'doc-coherence'] },
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
  sourceAccess, includeAttribution,
  harnessModels = { verify: 'sonnet', synthesis: 'opus' } } = parsedArgs

phase('Review')

const laneResults = await parallel(lanes.map(lane => () => {
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
      `exactly.\n${context}\nRead the diff, the project docs, and any ` +
      `source files referenced by the diff that you need for context.`

  return agent(prompt, {
    label: `review:${lane.key}`,
    phase: 'Review',
    model: lane.model ?? 'sonnet',
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

phase('Verify')

const verified = await parallel(merged.map(finding => () =>
  agent(
    `You are adversarially verifying a single code-review finding. Read the ` +
    `actual code before judging — never judge from the finding text alone.\n\n` +
    `Finding: ${JSON.stringify(finding)}\n\n` +
    `The diff is at: ${finding.diff_path}\nRepo root: ${repoRoot}\n` +
    `${sourceAccess}\n\n` +
    `Classify the finding: valid (real, you verified it against the code), ` +
    `likely (probably real but needs more context), disputed (evidence is ` +
    `weak), invalid (false positive — the code contradicts the claim), ` +
    `out-of-scope (real but on lines the diff did not modify). Refute only ` +
    `with concrete evidence from the code; do not dismiss ` +
    `uncertain-but-plausible findings. Re-score severity and confidence ` +
    `from your own reading (confidence 100 = you verified it yourself).`,
    { label: `verify:${finding.file}`, phase: 'Verify', model: harnessModels.verify,
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
  `${docsPaths.join(', ')}. ${sourceAccess} Read the diff so your overall ` +
  `assessment reflects the actual change, and call out anything the ` +
  `reviewers collectively missed.\n\n` +
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
  { label: 'synthesize', phase: 'Synthesize', model: harnessModels.synthesis,
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

- **All reviewer lanes error:** stop only if **sonnet** Workflow lanes all failed
  (rare). **Opus usage limit is not fatal** — set `harness_tier=sonnet-only`,
  rebuild lanes with all models `sonnet`, set `harnessModels.synthesis` to
  `sonnet`, relaunch Workflow. **Never stop `/review-pr` for Opus limits.**
- **The workflow itself fails mid-run:** relaunch with `{scriptPath, args,
  resumeFromRunId}` — completed lanes return cached results instantly; only the
  failed part re-runs.
- **An external lane hits a usage limit mid-panel:** walk `fallbackCmds`, then
  native sonnet for that lane; write `native-only` cache before the next invoke
  in the same session.

## Hard rules

1. The review pass runs as a **single `Workflow` invocation** — never run
   reviewers sequentially or hand-roll the fan-out with individual Agent calls.
2. Verification and synthesis happen **inside the workflow**, never in the main
   session (context pollution).
3. **External CLIs run read-only** — see step 4 (cursor-agent `--mode plan`; agy
   `--sandbox` and NEVER `--dangerously-skip-permissions`).
4. Never fabricate findings when a lane errors — record the failure from
   `laneErrors`.
5. The Review→Verify and Verify→Synthesize barriers are **intentional** (dedup
   needs all lanes; synthesis needs all survivors). Within each phase everything
   runs in parallel; do not collapse the phases.
6. Save `review.md` and `findings.json` to `$out_dir` before printing to the
   terminal.
