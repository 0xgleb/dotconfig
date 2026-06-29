---
name: review-audit
user-invocable: true
allowed-tools: Bash(git:*), Bash(gh:*), Bash(linear:*), Bash(cursor-agent:*), Bash(agy:*), Bash(command:*), Bash(mkdir:*), Bash(cat:*), Bash(mktemp:*), Bash(rm:*), Bash(test:*), Bash(grep:*), Bash(wc:*), Bash(date:*), Bash(basename:*), Bash(find:*), Read, Write, Edit, Agent, Workflow, Skill
description: Use to audit a whole codebase rather than a diff: run the multi-model review panel over the entire repository (default) or a specified package or path, treating all standing code as in scope. Triggers on requests to audit the repo, audit a crate or package, or do a full-codebase review for correctness, security, concurrency, and maintainability. Read-only by default; ends in a conversation to fix, file, or keep the findings.
argument-hint: [package-or-path]
---

Audit a whole codebase with the same multi-model panel the rest of the review
stack uses. Where `/review-pr`, `/review-loop`, and `/review-sweep` review a
**diff** (a PR, a branch against its parent, a stack), this reviews **standing
code** — the entire repository, or a package/path you name.

The **review engine** (panel, probes, prompts, the `review-panel` Workflow,
finding output) is the shared `~/.claude/skills/review-core/SKILL.md`. This skill
only differs in **scope** (it renders the codebase as a synthetic diff so the
diff-centric engine can audit it) and in **action** (a conversation to fix, file,
or keep the findings — it changes nothing by default).

Follow these steps precisely.

## 1. Resolve the audit scope

`$ARGUMENTS` is an optional package or path to scope the audit. With no argument,
audit the **whole repository**.

```bash
repo_root=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
scope="${ARGUMENTS:-.}"   # a dir / crate dir / pathspec relative to repo_root; "." = whole repo
```

Resolve `scope` against `repo_root`. If `$ARGUMENTS` names a thing that is not a
path (e.g. a bare crate name), resolve it to its directory before continuing
(`cargo metadata`-style lookup, or `git ls-files` filtered) — do not guess; if it
cannot be resolved to a path under the repo, stop and ask.

## 2. Prepare the workspace

```bash
ts=$(date +%Y-%m-%d_%H-%M-%S)
safe_scope=$(echo "$scope" | tr '/. ' '___')
out_dir="$repo_root/.tmp/claude-local-ctx/reviews/audit-${ts}-${safe_scope}"
mkdir -p "$out_dir"
```

Artifacts go under the gitignored `.tmp/`. If `.tmp/` is not gitignored (check
`grep -q '\.tmp/' "$repo_root/.gitignore"`), ask before adding it — never modify
`.gitignore` silently.

## 3. Build the audit target (the codebase as a synthetic diff)

The engine reviews a unified diff, so render the scoped tree as an all-additions
diff against the **empty tree**. Everything tracked at `HEAD` under `scope`
appears as added lines, which is exactly "review this code as it stands". Gitignored
paths (`target/`, `node_modules/`, `.direnv/`, `.tmp/`) are absent from `HEAD`, so
they drop out for free; exclude the tracked lockfiles explicitly.

```bash
empty=$(git hash-object -t tree /dev/null)   # the canonical empty-tree object
git -C "$repo_root" diff "$empty" HEAD -- "$scope" \
  ':(exclude)*.lock' ':(exclude)Cargo.lock' ':(exclude)flake.lock' \
  > "$out_dir/diff.patch"
git -C "$repo_root" diff --name-status "$empty" HEAD -- "$scope" \
  ':(exclude)*.lock' ':(exclude)Cargo.lock' ':(exclude)flake.lock' \
  > "$out_dir/files.txt"
wc -l "$out_dir/diff.patch"
```

To audit the **working tree** (including uncommitted edits) instead of the
committed state, drop `HEAD` from the `git diff` (diff the empty tree against the
working tree). Default to `HEAD` — a committed, reproducible snapshot.

Refuse to proceed on an empty target (nothing tracked under `scope`). **A whole
repo is large** — expect this to far exceed the panel's single-pass range, so it
will lean hard on chunking (step 5). If the target is very large (more than
~8000 lines) tell the user it is a long, token-heavy run and that scoping to a
package (`/review-audit crates/<name>`) is much cheaper; proceed once they
confirm or if they already scoped it.

## 4. Load project context

```bash
find "$repo_root" -maxdepth 3 \( -name "CLAUDE.md" -o -name "AGENTS.md" \) \
  -not -path "*/node_modules/*" -not -path "*/target/*"
```

Keep the paths — they become `docsPaths` for the engine. There is no PR
description; the "author description" the engine wants is the audit intent:
`"Full audit of <scope>: assess correctness, security, concurrency, and
maintainability of the standing code."`

## 5. Run the review engine

Run the shared engine in `~/.claude/skills/review-core/SKILL.md` (steps 1–7).
Pass the contract inputs:

| Contract input          | Value for review-audit                                                 |
| ----------------------- | --------------------------------------------------------------------- |
| `out_dir`, `{DIFF_PATH}`, `{FILES_PATH}`, `{REPO_ROOT}` | from steps 2–3 (`$out_dir/diff.patch`, `$out_dir/files.txt`) |
| `{PROJECT_DOCS_PATHS}`  | the docs paths from step 4                                              |
| `{PR_DESCRIPTION}`      | the audit-intent sentence from step 4                                  |
| `{SOURCE_ACCESS}`       | `Read source files directly from the working tree, which is the code under audit.` |
| `{SCOPE_NOTE}`          | `This is a full audit, not a change review: the diff renders the entire scoped codebase as additions, so ALL of it is standing code under audit. "Pre-existing, on lines the diff did not modify" does not apply here — everything shown is in scope.` |
| `{INSPECTOR_ARG}`       | empty string                                                          |
| `{REPORT_HEADER}`       | `# Audit — <scope>\n**Repo:** <repo_root>\n**Commit:** <HEAD sha>\n**Files:** <N>\n**Size:** <LOC> lines\n**Panel:** 2x Opus, Sonnet, external + composer lanes, 4 inspectors; per-finding verification; Opus synthesis` |
| `{TERMINAL_HEADER}`     | `Audit — <scope>\n<N> files, <LOC> lines`                             |
| `{SYNTHESIS_EXTRA}`     | empty string                                                          |
| `{INCLUDE_ATTRIBUTION}` | `true`                                                                |

**Chunking is the norm here, not the exception.** Apply review-core's chunk
splitting: read `files.txt`, group files into domain/crate/directory chunks each
under ~3,500 lines, generate a per-chunk diff with the same empty-tree command
plus a path filter (`git diff "$empty" HEAD -- crates/dto/ ...`), duplicate the
reviewer lanes per chunk (inspectors run once over the full target), and pass all
lanes to a single workflow invocation — dedup and verification handle the rest.
Report the chunk plan before running.

The engine writes `$out_dir/review.md` and `$out_dir/findings.json` and prints the
terminal summary. If `findings` is empty, say the audit found nothing actionable
and stop.

## 6. Enter the audit conversation

After the engine prints, **stay in the session** — an audit is a report you act
on, not a one-shot. Do not auto-fix: a whole-repo audit can surface dozens of
findings across unrelated areas, and the user decides what is worth doing.

Say something like:

> Audit saved to `<path>` — N findings (C critical, H high, ...). Want me to fix
> a subset now, file them as issues, or leave the report?

Then wait. Handle follow-ups:

- **"tell me more about #N"** — read the full finding from `review.md`, re-read the
  source to confirm it yourself, explain it conversationally.
- **"fix #N, #M"** (or "fix the criticals") — fix only the named/selected findings
  using `/review-loop`'s fix discipline: read source, re-verify the finding is
  still valid, apply a surgical fix, add/adjust tests per the project docs, run
  the project's **discovered** check command (never hardcode `/ci` or `f check`).
  Keep fixes scoped to what was asked; do not drift into a whole-repo rewrite.
  Leave the changes uncommitted for the user (single-branch safe default).
- **"file these"** / **"file the highs to Linear"** — turn the selected findings
  into issues. Linear for st0x / rainlanguage repos (invoke the `linear` skill,
  one issue per finding, draft shown and confirmed before any `linear` write);
  GitHub issues elsewhere (`gh issue create`, problem-only per the user's
  issue-writing rule — describe the problem, no proposed solution). Always show
  drafts and get explicit confirmation before creating anything.
- **"I'm done"** — summarize what was fixed/filed (if anything) and end.

## Hard rules

1. **Read-only by default.** The audit produces a report and changes nothing
   until the user explicitly asks to fix or file. Never auto-fix a whole-repo
   audit.
2. The audit target is a synthetic diff against the empty tree — it is the code
   under audit, so "pre-existing / out of scope" never applies; everything shown
   is in scope.
3. **Chunk large targets.** A whole repo exceeds the single-pass range; split by
   crate/dir per review-core and report the chunk plan. Warn on very large runs.
4. The review runs as a single `Workflow` invocation per pass (review-core) —
   never hand-roll the fan-out. External CLIs run read-only (review-core step 4 /
   hard rules): cursor-agent `--mode plan`; agy `--sandbox` and never
   `--dangerously-skip-permissions`.
5. **Filing is gated.** Never create a Linear or GitHub issue, or comment
   anywhere, without showing the draft and getting explicit confirmation. Linear
   for st0x / rainlanguage, GitHub issues elsewhere; issues describe the problem
   only, not a proposed solution.
6. **Fixes stay surgical and scoped** to what the user selected; verify each
   finding against current source first; leave fixes uncommitted for review.
7. Never silently modify `.gitignore` — ask before adding `.tmp/` if missing.

## Failure modes

- **Empty target** — nothing tracked under `scope`; say so and stop (check the
  path / that you are in the right repo).
- **`scope` does not resolve to a path** — a bare name that is not a crate dir;
  stop and ask rather than auditing the whole repo by accident.
- **Target too large to be affordable** — warn, recommend scoping to a package,
  and proceed only on confirmation; rely on chunking either way.
- **All reviewer lanes error** — stop (review-core engine failure modes);
  inspector lanes erroring is non-fatal.
- **The workflow fails mid-run** — relaunch with `{scriptPath, args,
  resumeFromRunId}`; completed lanes return cached results.
- **Not a git repo** — the synthetic-diff trick needs git; tell the user to run
  it inside the repo (or `git init` first).
