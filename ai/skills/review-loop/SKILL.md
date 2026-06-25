---
name: review-loop
user-invocable: true
allowed-tools: Bash(gt:*), Bash(but:*), Bash(direnv:*), Bash(git:*), Bash(gh:*), Bash(cursor-agent:*), Bash(gemini:*), Bash(command:*), Bash(linear:*), Bash(cargo:*), Bash(nix:*), Bash(mkdir:*), Bash(cat:*), Bash(mktemp:*), Bash(rm:*), Bash(test:*), Bash(grep:*), Bash(wc:*), Bash(date:*), Bash(basename:*), Bash(find:*), Read, Write, Edit, Agent, Workflow, AskUserQuestion
description: Cross-review the current branch with a multi-model Workflow panel (2x Opus, Sonnet, a Composer cross-lab augment lane, 2 frontier external lanes that fall back GPT-5.5 -> Gemini per Cursor usage limits, + inspectors), auto-fix findings, and re-review until clean. Re-review passes use fast delta verification. Loops automatically — only stops for user input on disputed findings or massive changes. Pass `stack` to run the loop across the whole upstack, amending each branch.
argument-hint: [stack]
---

Run a full self-review loop on the current branch: review → auto-fix → CI →
re-review → repeat until clean. Use this right before you `gt submit` something
you wrote yourself, to catch issues before reviewers do.

The **review engine** (panel, probes, prompts, the `review-panel` Workflow,
finding output) is shared with `/review-pr` and `/review-sweep` and lives in
`~/.claude/skills/review-core/SKILL.md`. This skill **scopes the diff to the
current branch** and, after the engine returns findings, **takes the fix-loop
action**: triage → fix → re-review until clean. Read `review-core` when a step
says "run the review engine".

The loop is **automatic by default**. Findings that clearly should be fixed are
fixed without asking. The loop re-reviews after each fix pass to catch issues
introduced by the fixes themselves. It stops when a review pass returns no new
actionable findings.

**Speed design:** the **first pass** runs the multi-model panel, **adaptively
sized to the diff** (small diffs run fewer lanes). Each finding is adversarially
verified **before** triage so false positives never cost a fix-and-re-review
cycle. Fix-now findings are applied **in parallel by default** (one agent per
file cluster). A **compile gate** runs after each fix pass so a broken fix never
burns a review pass, and a **formatter-only delta** is treated as verified by
construction and skips the pass entirely. **Re-review passes** run in fast delta
mode (per-fix verifiers plus one broad sweep of the fix delta) and **escalate to
a full independent panel pass** when the fix delta is large, scope grew, or it
touched security-sensitive paths. On an escalated full pass, the project's check
command overlaps the panel concurrently.

**Argument:** with no argument, the loop runs on the **current branch only** and
never touches version control (the safe default). With `stack`, it runs across
the **entire upstack** — current branch and every branch above it — amending each
branch as it goes (see **Stack mode** below).

Follow these steps precisely.

---

## Stack mode (`/review-loop stack`)

When invoked with the `stack` argument, wrap the single-branch loop (steps 1–11)
in an upstack walk: review-loop a branch, fold the fixes into its commit, advance
to the next branch, and repeat to the top of the stack. Passing `stack` is an
explicit opt-in to the amend-and-advance flow, so in stack mode **hard rule #4 is
relaxed**: you MAY amend fixes into the current branch before moving up (`gt
modify -a` under Graphite, `but absorb` under GitButler). When the walk finishes
converged, **submit the modified stack** (`gt ss` / `but push`) so the fixes
reach the PRs — see the Stack flow's final step. Submitting is not publishing:
never `--publish`, flip draft→ready, open new PRs, or post PR comments.

With no `stack` argument, skip this section entirely and run steps 1–11 once on
the current branch.

### Detect the stacking tool

Stack mode is tool-specific — the user runs Graphite on some repos, GitButler on
others, and plain git on the rest. Detect which (same detection as
`/review-sweep`):

```bash
repo_root=$(git rev-parse --show-toplevel)
if [ -f "$repo_root/.git/.graphite_repo_config" ]; then tool=graphite
elif [ -d "$repo_root/.git/gitbutler" ];          then tool=gitbutler
else tool=none
fi
echo "stacking tool: $tool"
```

(For a linked worktree, `$repo_root/.git` is a file — resolve the real git dir
with `git rev-parse --git-common-dir` and look for the markers there.)

**`tool=none` (plain git):** there is no stack to walk. Tell the user this repo
has no stacking tool, run steps 1–11 once on the current branch (the normal
single-branch loop), and stop — do not amend or advance.

The rest of this section branches on `$tool`. Each branch gets its own review
directory (the step-2 `out_dir` is branch-named), its own diff against its own
parent, and its own 4-pass cap. The Defer-to-Linear step (10) still applies per
branch.

### Stack adapter

| Adapter operation         | Graphite                                              | GitButler                                              |
| ------------------------- | ----------------------------------------------------- | ------------------------------------------------------ |
| ready check               | working tree clean                                    | on a `gitbutler/*` workspace branch (`but status` ok)  |
| advance to next branch    | `gt up`                                               | none — all virtual branches are applied at once        |
| scope one branch's diff   | `git diff $(gt parent)`                               | `but branch show <branch>` (commits ahead of its base) |
| amend fixes into a branch | `gt modify -a` (restacks descendants; NEVER `gt fold`) | `but absorb <branch>` (`--dry-run` first)             |
| return to start           | `gt checkout <start-branch>`                          | none                                                   |

`but` is provided by the repo's flake/devenv — if it is not on `PATH`, invoke it
as `direnv exec "$repo_root" but …` for every `but` call. Never run `but setup` /
`but teardown` or otherwise change GitButler mode yourself.

### Stack flow — [Graphite]

`gt up` walks a single child. On a **tree** stack (a branch with multiple
children) it is ambiguous — for those, point the user at `/review-sweep`, which
traverses the tree properly. This linear walk covers the common single-child
upstack.

1. Record the starting branch: `git branch --show-current`. You return here at
   the very end.
2. Run the full single-branch loop (**steps 1–11**) on the current branch.
   - **Relax the step-1 clean-tree gate after the first branch**: `gt up`
     restacks descendants, so a non-empty tree from that is expected. Still stop
     if there are unrelated uncommitted edits you did not make.
3. After the loop converges clean and the project's check command has passed, if
   any files were modified on this branch (by fixes or by the check command),
   amend them into the branch's commit with `gt modify -a` (invoke the `graphite`
   skill). This also restacks descendants. If nothing was modified, skip.
4. Move up the stack with `gt up` (via the `graphite` skill):
   - If `gt up` succeeds and the branch changed, print `"Moving up stack ->
     <new branch>"` and repeat from step 2.
   - If `gt up` fails or the branch did not change, you are at the top. Print
     `"Reached top of stack."` and end the stack walk.
5. If the single-branch loop **fails to converge** on any branch (hits the 4-pass
   cap), stop on that branch — do **NOT** continue up the stack. Report which
   branch is stuck and follow the normal non-convergence flow.
6. When done, return to the starting branch (`gt checkout <starting-branch>`). If
   the walk **converged** (did not stop on a stuck branch) and amended any
   branch, **submit the stack**: `gt ss` from the start branch so the fixes reach
   the PRs — review fixes left local are worthless. When a *lower* PR is already
   approved, `gt submit --stack --dry-run` first to see which approvals the
   resubmit disturbs. Submitting is NOT publishing: never `--publish`, flip
   draft→ready, open a NEW PR, post/resolve PR comments, or override branch
   protection. Then print the per-branch summary below. (If the walk stopped on a
   stuck branch, do not submit — report and let the user decide.)

### Stack flow — [GitButler]

All virtual branches are applied at once, so there is no checkout/advance — you
iterate the applied series in place.

1. Confirm workspace mode: `but status` must succeed (you are on a `gitbutler/*`
   workspace branch). If it fails with "Setup required" or similar, **stop and
   tell the user to enter GitButler workspace mode first**.
2. Enumerate the applied series bottom→top from JSON (`but status -j`); confirm
   field names with `but status -h` before relying on them — do not guess.
3. For each branch, scope its diff with `but branch show <branch>` (its commits
   ahead of base) into that branch's `out_dir`, then run the full single-branch
   loop (**steps 1–11**) against that diff.
4. After the loop converges clean and the project's check command has passed,
   fold the fixes into that branch with `but absorb <branch>` — run `but absorb
   <branch> --dry-run` first and confirm it targets the intended branch. If
   nothing was modified, skip.
5. Same non-convergence rule: if a branch hits the 4-pass cap, stop on it — do
   **NOT** advance to the next series. Report which branch is stuck.
6. When done, if the walk converged (did not stop on a stuck branch) and absorbed
   any fixes, **push the modified series** (`but push`) so the fixes reach the
   PRs — never `but` mode changes, never `--publish`/draft-flip, never new PRs or
   PR comments. Then print the per-branch summary below. No return-to-start
   checkout is needed (nothing was checked out).

Per-branch summary (either tool):

```
Stack review-loop summary:
  branch-a: converged clean (fixed 3, amended)
  branch-b: converged clean (no changes)
  branch-c: stuck (4-pass cap — see above)
```

---

## 1. Preflight

Verify prerequisites before doing anything:

1. You are in a git repo:
   ```bash
   git rev-parse --show-toplevel
   ```
   Single-branch mode (the default) works on **any** git repo — Graphite,
   GitButler, or plain git alike. Only `stack` mode needs a stacking tool; it
   detects which one in the **Stack mode** section above (and bails to a
   single-branch run under plain git). Under Graphite, `gt log short` shows the
   current stack; skip it elsewhere.

2. `gt` is on PATH **only if** this is a Graphite repo running in `stack` mode
   (`command -v gt`). Plain-git and GitButler repos do not need it.

3. The working tree is clean or stashed. A dirty tree pollutes the diff and
   confuses reviewers:
   ```bash
   git status --porcelain
   ```
   If dirty, tell the user and stop.

The external-lane usage-limit probes are part of the review engine — they run in
step 4 (review-core step 1). Nothing to do here for them.

## 2. Resolve scope & prepare workspace

Determine what to review. On a stacked branch, **always diff against the branch's
own parent**, not trunk — reviewing against trunk would include ancestor PRs and
drown the reviewers in unrelated changes. Resolve the parent per stacking tool:
Graphite → `gt parent`; GitButler stack mode → the base from `but branch show
<branch>` (set `parent` to that base SHA); plain git → the merge-base with the
default branch. The command below tries `gt parent` and falls back to merge-base,
which is correct for plain git and for Graphite; in GitButler `stack` mode,
override `parent` with the branch's base from the adapter.

```bash
default_branch=$(git symbolic-ref refs/remotes/origin/HEAD --short 2>/dev/null || echo origin/master)
parent=$(gt parent 2>/dev/null || git merge-base "$default_branch" HEAD)
branch=$(git rev-parse --abbrev-ref HEAD)
head_sha=$(git rev-parse HEAD)
parent_sha=$(git rev-parse "$parent")
repo_root=$(git rev-parse --show-toplevel)
ts=$(date +%Y-%m-%d_%H-%M-%S)
safe_branch=$(echo "$branch" | tr '/' '_')
out_dir="$repo_root/.tmp/claude-local-ctx/reviews/${ts}-${safe_branch}"
mkdir -p "$out_dir"
```

Write the diff and file manifest. Diff against the working tree (no `..HEAD`) so
re-review iterations automatically include uncommitted fixes:

```bash
git diff "$parent" > "$out_dir/diff.patch"
git diff --name-status "$parent" > "$out_dir/files.txt"
wc -l "$out_dir/diff.patch"
```

Refuse to proceed if the diff is empty. If it exceeds 5000 lines, warn the user
and ask whether to proceed — reviewer quality degrades on huge diffs.

**Ensure the artifact folder is gitignored.** Artifacts are written under
`$repo_root/.tmp/claude-local-ctx/`. If `.tmp/` is not already gitignored (check
with `grep -q '\.tmp/' "$repo_root/.gitignore"`), ask the user for permission to
add it. Do not silently modify `.gitignore`.

## 3. Load project context

```bash
find "$repo_root" -maxdepth 3 \( -name "CLAUDE.md" -o -name "AGENTS.md" \) \
  -not -path "*/node_modules/*" -not -path "*/target/*"
```

Keep only the paths — they become `docsPaths` for the engine. Reviewers read them
themselves.

Also extract the PR description if a PR exists for this branch:

```bash
pr_body=$(gh pr view --json body --jq '.body' 2>/dev/null || echo "No PR description available.")
```

Strip bot-appended footers before embedding the description in prompts: cut
everything from the first HTML-comment footer marker onward (e.g. `<!--
codesmith:footer -->`, CodeRabbit/Codesmith badges, tracking links). Reviewers
should see only the author-written description.

### Discover the project's check command

The loop runs the project's own verification after it converges. This command is
**project-specific and must be declared by the project**, never assumed by this
skill — different repos check themselves in completely different ways, and
hardcoding one repo's command (or a laptop-global wrapper) would couple this skill
to a setup it shouldn't know about. Discover it, in order:

1. An explicit declaration in the project's `CLAUDE.md` / `AGENTS.md` (a
   "check"/"CI"/"verify"/"build commands" section naming the command to run).
2. A task runner target the repo defines — `just check`, a `Makefile`
   `check`/`test` target, `package.json` scripts, `cargo`/`nix` invocations the
   docs point at.

Record the discovered command as `check_cmd` and use it everywhere this skill
says "the project's check command". **If the project declares no check command,
set `check_cmd` to empty and skip every check step** (convergence is then decided
by the review passes alone) — do not invent one.

### Prewarm the check shell (overlap setup with the panel) — rarely needed

**Prefer the project's direnv-provided dev shell.** If the repo has an `.envrc`
(`use flake` / `use nix`), direnv has already loaded the default dev shell — the
tools the check command needs are on `PATH` and the shell is warm. There is
**nothing to prewarm**; skip this. Run commands through the active environment (or
`direnv exec "$repo_root" <cmd>`), not a fresh `nix develop`.

Only reach for a manual `nix develop` when the check command needs a
**non-default** shell that direnv does *not* load (e.g. a `.#integration` /
`.#e2e` shell) and that shell is slow cold. Even then, read the **real** devShell
attr from the project's check command or `nix flake show`. **Never invent an attr
like `.#ci`**; if you can't name the shell, don't prewarm. Repos with no Nix dev
shell have nothing to warm — skip silently. On the rare occasion it applies:

```bash
nix develop .#<real-non-default-attr> -c true >/dev/null 2>&1 &
```

## 4. Run the review engine

Run the shared engine in `~/.claude/skills/review-core/SKILL.md` (steps 1–7:
probes → reviewer prompts → inspector prompts → lanes → the `review-panel`
Workflow → after-workflow handling → print findings). Pass the contract inputs:

| Contract input          | Value for review-loop                                                   |
| ----------------------- | ---------------------------------------------------------------------- |
| `out_dir`, `{DIFF_PATH}`, `{FILES_PATH}`, `{REPO_ROOT}` | from step 2 (`$out_dir/diff.patch`, `$out_dir/files.txt`) |
| `{PROJECT_DOCS_PATHS}`  | the docs paths from step 3                                              |
| `{PR_DESCRIPTION}`      | `pr_body` from step 3 (or "No description available")                  |
| `{SOURCE_ACCESS}`       | `Read source files directly from the working tree, which already reflects the change under review.` |
| `{SCOPE_NOTE}`          | `The diff is scoped to exactly the changes under review (the current branch against its parent).` |
| `{INSPECTOR_ARG}`       | empty string (the inspectors review the current branch)                |
| `{REPORT_HEADER}`       | `# Review — <branch>\n**Commit:** <head_sha>\n**Parent:** <parent_sha> (<parent branch>)\n**Files changed:** <N>\n**Diff size:** <LOC> lines\n**Panel:** 2x Opus, Sonnet, <resolved external/composer lanes>, 4 inspectors; per-finding verification; Opus synthesis` |
| `{TERMINAL_HEADER}`     | `Review — <branch>\n<N> files, <LOC> lines changed`                    |
| `{SYNTHESIS_EXTRA}`     | empty string                                                           |
| `{INCLUDE_ATTRIBUTION}` | `true`                                                                 |

Keep the `scriptPath` the workflow returns — re-review escalation (step 9) reuses
it for later full-panel passes. The engine writes `$out_dir/review.md` and
`$out_dir/findings.json` and prints the terminal summary; this skill triages the
returned `findings` array next.

If the review reports **no findings**, print that prominently and exit — nothing
to loop over.

## 5. Triage input

Triage works directly on the structured `findings` array returned by the engine
(also saved to `findings.json`) — no report parsing. Each finding carries: `title`,
`severity` (re-scored by the verifier), `verdict` (valid | likely | disputed),
`confidence` (re-scored), `category`, `file` + `line_start`/`line_end`, `finding`,
`recommended_fix`, and the verifier's `rationale`.

Findings the verifier judged `invalid` or `out-of-scope` are already in the
engine's `dismissed` list — never triage those.

## 6. Build the triage plan

For each remaining finding, compute a **default action** based on severity,
verdict, and confidence. **Bias heavily toward fixing now** — only defer when the
fix is massive enough to warrant its own stacked PR.

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

**Discuss**: the evidence is weak or reviewers disagree. Show the user the full
finding and ask what to do. Default to fixing unless it's massive.

**Defer to Linear** is NOT a default action. Only use it when:
- The user explicitly asks to defer a specific finding, OR
- A fix is large enough that it should be a separate stacked PR (e.g., a
  multi-file refactor or new feature, not a surgical bug fix)

When in doubt, fix it now.

## 7. Present the plan and auto-apply

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

If the user picks "Show me the details", present the finding conversationally and
re-ask without that option.

After resolving discuss items, print the consolidated plan:

```
Plan:
  Fix now (4):     #1, #2, #3, #4
  Dismiss (1):     #5
```

## 8. Fix-now pass (parallel by default)

Apply the "fix now" findings. **Parallelize by default**: findings that touch
different files are independent and should be fixed concurrently.

1. **Cluster the fix-now findings by file.** All findings whose `file` is the
   same (or in the same tightly-coupled module) go in one cluster. Each file
   belongs to exactly one cluster, so no two clusters ever edit the same file —
   that makes concurrent edits to the main working tree safe with **no worktree
   isolation** needed.
2. **Decide serial vs fan-out:**
   - **Stay in the foreground, serial**, when: there are ≤2 clusters; the fixes
     **interact** (one fix's correctness depends on another's); a fix needs
     non-trivial judgment, test authoring, or might turn out larger than the
     report suggests (e.g. a critical security fix). For these, do them yourself,
     one at a time, so you can stop and re-triage if a fix balloons.
   - **Fan out** the rest: dispatch the independent clusters as a single
     `Workflow`, one agent per cluster.
3. **Foreground serial fix**, per finding: announce it, read the source, RE-VERIFY
   it is still valid against the current code (it may have changed since the
   review — don't trust the report blindly), apply the `recommended_fix` with
   `Edit` (or `Write` for new files), keep it surgical (no unrelated cleanups,
   match the project's style), add/update tests if the fix touches them or the
   project docs mandate coverage for this logic, then print a one-line summary.
   If a fix turns out larger than expected or more nuanced than the report,
   **stop and tell the user** — offer to re-triage (defer, dismiss, or adjust).
4. **Fan-out Workflow** for the independent clusters — pass `args`:
   `{clusters, repoRoot, fullDiffPath: "$out_dir/diff.patch", docsPaths}` where
   each cluster is `{key, findings: [...]}`:

```javascript
export const meta = {
  name: 'review-fix-fanout',
  description: 'Apply agreed review fixes in parallel, one agent per file cluster',
  phases: [{ title: 'Fix', detail: 'one agent per file cluster' }],
}

const FIX_RESULT = {
  type: 'object',
  required: ['key', 'summary'],
  properties: {
    key: { type: 'string' },
    summary: { type: 'string' },
    skipped: { type: 'array', items: { type: 'string' } },
    notes: { type: 'string' },
  },
}

const parsedArgs = typeof args === 'string' ? JSON.parse(args) : args
const { clusters, repoRoot, fullDiffPath, docsPaths } = parsedArgs

const results = await parallel(clusters.map(cluster => () =>
  agent(
    `You are applying agreed code-review fixes to one cluster of findings that ` +
    `all touch the same file(s). Repo root: ${repoRoot}. The full PR diff ` +
    `(context) is at: ${fullDiffPath}. Project docs: ${docsPaths.join(', ')}.\n\n` +
    `Findings to fix (JSON): ${JSON.stringify(cluster.findings)}\n\n` +
    `For each finding: read the current source at its location, RE-VERIFY the ` +
    `finding is still valid against the current code (if it is already resolved ` +
    `or no longer applies, add it to "skipped" and move on), then apply the ` +
    `recommended_fix with Edit (or Write for new files). Keep every change ` +
    `surgical — no unrelated cleanups, match the project's style. If a fix ` +
    `touches tests or the project docs mandate test coverage for this kind of ` +
    `logic, add/update the tests. Report what you changed. Only edit files in ` +
    `this cluster — never touch another cluster's files.`,
    { label: `fix:${cluster.key}`, phase: 'Fix', schema: FIX_RESULT })
))

return { results: results.filter(Boolean) }
```

   After the workflow returns, read each cluster's `summary`/`skipped` and report
   what was changed. You own the result — spot-check the edits.

### Compile gate

After **all** fix-now items are done (serial and fan-out merged), run the
**compile gate** before any re-review: the project's fastest typecheck scoped to
what was touched (for Rust, `cargo check -p <touched crates>`; otherwise the
project's equivalent). Fix any compile errors immediately — never enter a
re-review pass with code that doesn't compile; that wastes an entire pass. The
compile gate is NOT a substitute for the project's check command — full tests and
lints still run only after convergence.

Then proceed directly to step 9 (re-review).

## 9. Re-review loop (delta + escalation)

Re-review after every fix pass to catch issues introduced by the fixes. This is
the core of the automatic loop.

**CRITICAL: The re-review is NOT optional.** After fixing findings, you MUST
re-review at least once. Do not skip it because the fixes "looked
straightforward." Only a review pass determines when the loop is done.

**CRITICAL: Convergence requires a CLEAN review pass.** The loop is ONLY done when
a review pass returns no new actionable findings. Fixing the last batch is NOT
convergence. The pattern is always: `review → fix → review → fix → review(clean) →
check → done`. You can never end on a fix. The project's check command runs only
after convergence, and if it makes changes, you re-enter the loop.

### Choose the re-review mode

Compute the fix delta (everything the loop has changed so far — fixes are
uncommitted, so this is the working-tree diff against HEAD):

```bash
git diff HEAD > "$out_dir/delta-iter${N}.patch"
git diff HEAD --stat | tail -1
git diff "$parent" > "$out_dir/diff-iter${N}.patch"   # updated full diff
```

**Formatter-only skip.** If the only thing that changed since the last reviewed
state is the output of a deterministic formatter/hook (`cargo fmt`, `deno fmt`,
`prettier`, `yamlfmt`, `nixfmt`) and that formatter now passes, **do not spawn a
review pass over it** — formatter output cannot introduce a review-worthy finding.
Confirm the delta matches what re-running the formatter produces; if any
hand-written line changed, fall through to the normal modes. Treat a pure-formatter
delta as verified by construction and skip to convergence.

**Escalate to a full panel pass** (re-run the review engine — review-core steps
1–7 — with the updated full diff, applying review-core's adaptive sizing; reuse
the workflow `scriptPath` from step 4) when any of:
- the fix delta exceeds ~200 changed lines, OR
- the fixes touched files that no fixed finding implicated (scope grew), OR
- the fixes touched **security-sensitive paths** (auth, secrets,
  payment/financial, on-chain, migrations) — a fresh independent pass is worth
  the cost here even for a small delta.

**Otherwise run delta mode** — the default and fast path. One small workflow: a
fix-verifier per fixed finding plus one Opus broad sweep of the fix delta. Pass
`args`: `{fixedFindings: <findings fixed this loop so far>, deltaDiffPath,
fullDiffPath, repoRoot, docsPaths}`. Reuse the returned `scriptPath` on later
delta passes.

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
    category: { enum: ['correctness', 'security', 'convention', 'maintainability', 'tests', 'doc-coherence'] },
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
    { label: 'delta-sweep', phase: 'Sweep', model: 'opus',
      schema: SWEEP_SCHEMA }),
])

return {
  verifications: (verifications || []).filter(Boolean),
  sweepFindings: sweep ? sweep.findings : [],
}
```

**Overlap the check command with an escalated full-panel pass.** A delta pass is
cheap, so running the check command only after it converges is fine. But when
this iteration **escalated to a full panel** (slow), start the project's check
command in the background as you fire the panel — they read the same working tree
and don't interact — then gate convergence on both: panel clean **and** the check
command green with no changes → converged; panel clean **and** the check command
made only formatter changes → apply the formatter-only skip; panel not clean →
discard the in-flight check result (it reruns at the next convergence). Never
overlap the check command with a cheap delta pass — the wasted runs aren't worth
it. (Skip entirely if the project declared no check command.)

### Interpret the result

1. Save the result to `$out_dir/delta-iter${N}.json` (audit trail).
2. **Clean pass** = every verification has `fixed: true` with no `new_issues`, and
   `sweepFindings` is empty. The loop has converged. Run the project's check
   command (`check_cmd`) and let it run until it passes or it needs the user. If
   the project declared **no** check command (`check_cmd` empty), there is nothing
   to run, so skip straight to step 10/11. If the check command itself commits or
   amends on success, that behavior is **overridden by this loop**: never amend in
   single-branch mode (hard rule 4); in stack mode the stack flow amends once per
   branch after convergence, so the check command must not amend separately.
   - If the check command made **no code changes**: proceed to step 10/11.
   - If it **made code changes** (lint, formatting, auto-fixes): run one more
     delta pass over the new delta. This converges quickly since those changes are
     mechanical.
3. **Not clean**: collect unresolved findings (`fixed: false` — re-fix),
   `new_issues`, and `sweepFindings`. Filter out anything substantively identical
   to a finding already fixed or dismissed (compare file + line range +
   description). If nothing remains, treat as clean. Otherwise increment the
   iteration counter and loop back to step 6 (triage) with only the remaining
   findings.

**Cap at 4 review passes total** (full or delta — initial + up to 3 re-reviews).
If new findings keep appearing after 4 passes, stop and tell the user — the fixes
are likely introducing as many issues as they solve, and a human needs to assess.

Print a status line at the start of each iteration:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Re-review iteration <N> (<delta|full panel>) — checking for new issues
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

When an escalated full pass re-runs the engine, treat any external pool that
errored earlier in this invocation as exhausted and re-resolve the lane
assignment **without re-probing** it.

## 10. Defer-to-Linear loop (only if user explicitly deferred findings)

This step only runs if the user chose "Defer" for any discuss finding. Skip
entirely if no findings were deferred.

For each "defer" finding, invoke the `linear` skill. For each one:

1. **Draft the issue** in a tempfile, following the linear skill's "Drafting
   issues from review findings" pattern:

   - **Title:** a concise imperative summary derived from the finding title. Lead
     with the action, not the problem. Example: "Add retry on transient HTTP
     errors in broker client" not "Missing retry".
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

2. **Choose metadata**: priority by severity (critical -> urgent, high -> high,
   medium -> medium, low -> low, nit -> low). Labels: prefer `bug` for
   correctness/security, `tech-debt` for maintainability or doc-coherence, `test`
   for test-coverage findings. Project and team come from the repo's
   `.linear.toml` — let `linear` pick them up automatically. Do not pass `--team`
   or `--project` unless the user tells you which ones.

3. **Show the draft to the user** before running any `linear` command. Format:

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

6. **Print the issue URL** returned by `linear issue create` and record the issue
   ID — you'll reference them in the summary.

You can batch the confirmation step: if there are multiple "defer" findings, draft
all of them first, show all drafts, ask in one `AskUserQuestion` call (up to 4 at a
time). Don't skip showing the drafts — the user must see the title and body before
any issue is created.

## 11. Summarize

After all review iterations converge (no new findings) and any deferred Linear
issues are created (or skipped), print a final summary:

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

Then stop. Do not auto-run `gt modify`, `gt submit`, or any other mutation — the
user decides when to amend and push.

**In stack mode**, this is where the single-branch loop returns to the Stack flow:
the wrapper amends the branch (`gt modify -a`) and moves up. Print the per-branch
summary line, then continue the upstack walk — do not stop here. The stack is
submitted once at the end of the walk (Stack flow, final step), not per branch.

---

## Failure modes

- **All reviewer lanes error:** stop immediately, tell the user, don't proceed to
  triage. (Inspector lanes erroring is non-fatal.) See review-core engine failure
  modes.
- **Review returns no findings:** print "No findings" and exit the command
  successfully — nothing to loop over.
- **A fix turns out to be larger than expected:** stop, report progress, ask
  whether to continue, defer to a stacked PR, or dismiss.
- **Review pass cap hit (4 passes):** stop and tell the user. Summarize what was
  fixed in each iteration and what new issues keep appearing.
- **The workflow itself fails mid-run:** relaunch with `{scriptPath, args,
  resumeFromRunId}` — completed lanes return cached results instantly; only the
  failed part re-runs.
- **A Linear issue fails to create:** report the exact `linear` error, leave the
  draft tempfile in place, and continue with the rest of the deferred items. Ask
  the user whether to retry the failed one at the end.
- **The user says "stop" mid-loop:** immediately stop, then print the summary with
  what was completed so far. Do not silently abandon the rest.
- **cursor-agent not installed or out of usage:** review-core's probes handle this
  — gemini replaces the frontier lanes, composer/sonnet cover the rest. Only when
  every option fails does the panel shrink; warn the user either way.

## Hard rules

1. **Auto-fix without asking** for findings that match auto-fix criteria. Only ask
   the user about "discuss" findings.
2. **Bias toward fixing now.** Defer to Linear only when the user explicitly asks
   or the fix is too large for the current PR.
3. Never create Linear issues without explicit per-issue user confirmation of the
   exact draft content.
4. **Single-branch mode:** never amend, commit, or push — leave the fixes
   uncommitted for the user to review (the safe default). **Stack mode:** `gt
   modify -a` to amend fixes into each branch is expected, and once the walk
   converges you **submit the stack** (`gt ss` / `but push`) so the fixes reach
   the PRs. Submitting existing-PR code is the job; never `--publish`, flip
   draft→ready, open a NEW PR, post/resolve PR comments, or override branch
   protection.
5. Always use `--description-file` with `linear issue create`, never inline
   `--description`.
6. Always re-verify findings against the current source before applying fixes —
   the code may have changed since the review.
7. Keep fixes surgical. No "while I'm here" cleanups.
8. Fix-now findings are applied in **parallel by default** (one agent per file
   cluster); stay serial only for ≤2 clusters, interacting fixes, or fixes that
   need judgment. No two fix agents ever edit the same file.
9. Run the compile gate after every fix pass; run the project's check command
   (`check_cmd`, or skip if none) only after the review loop converges clean. If
   it makes code changes, run another delta pass.
10. Cap at 4 review passes (full or delta). Convergence requires a clean pass —
    never end on a fix. Stop and ask the user if you don't converge.
11. The review pass runs as a single `Workflow` invocation (review-core) — never
    run reviewers sequentially or hand-roll the fan-out. External CLIs run
    read-only (review-core step 4 / hard rules). Verification and synthesis happen
    inside the workflow, never in the main session.
12. Delta mode is only valid when the fix delta is small (~200 lines) and confined
    to files implicated by fixed findings — otherwise escalate to a full panel
    pass.
13. Never silently modify `.gitignore` — ask permission to add `.tmp/` if missing.
