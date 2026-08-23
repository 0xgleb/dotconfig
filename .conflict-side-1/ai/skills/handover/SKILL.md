---
name: handover
description: Prepare a session handover before hitting context or usage limits. Writes a temporary handover document under the current project-role workspace's .tmp/handoffs/ (active task, state, files with line refs, recent commits, blockers, exact pause point) and a paste-ready continuation prompt so a fresh session or agent resumes instantly with full situational awareness. Invoke as /handover, or when the user says they are running low on limits and need to hand off.
user-invocable: true
allowed-tools:
  - "Bash(git status *)"
  - "Bash(git log *)"
  - "Bash(git diff *)"
  - "Bash(git branch *)"
  - "Bash(git rev-parse *)"
  - "Bash(ls *)"
  - "Bash(mkdir *)"
  - "Read"
  - "Write"
  - "Edit"
  - "Grep"
  - "Glob"
---

# Handover

Capture the current session's state into a workspace-level temporary handover
document plus a paste-ready continuation prompt, so the next session (a fresh
context, or a different agent) resumes exactly where this one paused -- no
context rediscovery, no lost momentum. For a single-repository session, keep the
handover under that current project-role workspace's `.tmp/handoffs/`. Never
stage or commit it.

Use this when the user is near a context or usage limit, at the end of a long
session, or explicitly asks to hand off. The artifact is two things: a
**handover document** (what happened and exactly where we are) and a
**continuation prompt** (the message to paste into the next session).

## Terminal stop boundary

Invoking this skill ends implementation in the current session. Immediately stop
coding, reviewing, merging, publishing, testing, cleanup, and unrelated
investigation. From this point until the final report, perform only the bounded
state reads needed for the handover, reconcile durable todos, write the handover
artifact, and print its path and continuation prompt. Never resume the paused
work after the artifact is written or after a handover attempt fails.

Do not silently degrade to an inline summary. The required outcome is a real
handover file. If a tool or classifier blocks creation, preserve the exact
failure in the durable todo state, route the Pi defect to `pi-support`, report
that no file exists, and stop. Never claim a handover succeeded without a
successful file-write result.

## Step 1 -- Gather the git ground truth

Never summarize from memory; read the state of every repository in scope. Run
these commands in each covered repository:

```bash
git rev-parse --abbrev-ref HEAD                 # active branch
git log --oneline -20                           # recent commits (the session's trail)
git status --short                              # uncommitted + untracked
git diff --stat                                 # unstaged shape
git diff --stat --cached                        # staged shape
```

For each repository, note the branch, the last few commits that belong to this
session's work, and whether the working tree is clean or mid-edit. A dirty tree
means a **mid-implementation pause** -- say so explicitly and name the half-done
edit.

Attempt each required read once through the narrowest available command. A
blocked, aborted, unavailable, or failed read does **not** authorize continuing
implementation and does not prevent writing the rest of the handover. Record the
missing field as `unverified`, including the exact command and failure reason,
and preserve relevant durable todo/session evidence under that label. Never
turn durable state into asserted Git truth. Do not inspect unrelated repositories
merely because their todos or registry requests are globally visible.

## Step 2 -- Decide the pause type

- **Mid-implementation pause** -- an edit is started but not compiling/passing,
  or a multi-step change is partway. The handover must name the exact file,
  function, and next line of work so the next session does not re-derive it.
- **Clean boundary** -- the last unit of work is committed and green. The
  handover points at the next task, not a half-finished one.

State which it is at the top of the document. This is the single most useful
line for the next session.

## Step 3 -- Write the handover document

Choose the `.tmp/handoffs/` directory anchored to the current project-role
workspace:

- For a single-repository session, the project-role workspace is the session's
  repository workspace. Write inside that workspace even though it is a Git
  repository. For example, a Yielduck session rooted at
  `/Users/0xgleb/code/dataclique/yielduck` writes beneath
  `/Users/0xgleb/code/dataclique/yielduck/.tmp/handoffs/`.
- Never move a single-repository handover to the repository's parent, a global
  home-level `.tmp`, `/tmp`, or an inline-only substitute.
- For genuinely cross-repository work, use the current shared project-role
  workspace if the session has one. Only when no such workspace exists, use the
  nearest shared parent rather than arbitrarily assigning the handover to one
  participating repository.

Write to `<project-role-workspace>/.tmp/handoffs/YYYY-MM-DD-<slug>.md`, creating
the directory if absent. Resolve this path once and use it; do not bounce among
multiple directories or an inline-only handover. Treat the file as ephemeral
local state: do not add it to any `.gitignore`, stage it, commit it, or include
it in a PR. `<slug>` names the active task in kebab-case. Use this template,
filling every section with specifics -- file paths, `file:line` refs, command
names, commit SHAs. For unavailable facts, use the explicit `unverified` form
from Step 1 instead of inventing specifics. No vague summaries:

```markdown
# Handover: <active task>

- Date: <YYYY-MM-DD>
- Repositories / branches: <each repository, branch, and PR or "no PR">
- Pause type: mid-implementation | clean boundary
- Goal: <the outcome this work is driving to, one or two sentences>

## Where we are

<2-6 sentences: what is done and working, what is in progress. State the exact
pause point -- "mid-edit in `crates/foo/src/bar.rs:120`, the `baz` fn needs its
error arm" -- not "working on bar".>

## Done this session (committed)

- `<sha>` <subject> -- <one-line why it matters>
- ...

## In progress / uncommitted

<Each dirty file and what the half-done edit is; "none, tree clean" if a
boundary. Name the next concrete edit for each.>

## Next steps (in order)

1. <concrete action with file/function targets>
2. ...

## Blockers / open decisions

<Anything waiting on the user, an external system, or an unmade decision. "none"
if none.>

## Key context and gotchas

<Non-obvious facts the next session needs: a design constraint, a config value,
a workaround, a test that must stay green, a rule from AGENTS.md/CLAUDE.md that
shaped the approach. Link ADRs/docs by path.>

## How to verify / resume

<The exact commands to confirm the state (build, test, lint) and to pick up --
e.g. "cargo nextest run -p foo", "the failing test is X, make it pass">.
```

## Step 4 -- Write the continuation prompt

Below the document (or as a fenced block at its end), write the paste-ready
message for the next session. It is short, imperative, and self-contained -- it
names the repositories and branches, the task, the pause point, and the first
action, and points at the handover doc for detail:

```
Resume <task> across <repositories and branches>. Read <workspace>/.tmp/handoffs/<file>.md for full state.
We paused <mid-implementation at file:line | at a clean boundary>. Next: <first
concrete action>. Do not re-do committed work: <one-line what is already done>.
```

## Step 5 -- Validate before finishing

- **No secrets.** Scan the document for anything secret-bearing -- private keys,
  tokens, RPC URLs with embedded keys, passwords, seed phrases. Never write a
  secret value into the handover. If a value is needed, name the config key, not
  the value.
- **Specifics, not vibes.** Every "in progress" and "next step" line must cite a
  file, function, command, or commit. Reject your own vague lines and rewrite
  them.
- **Completeness.** A stranger with repo access and the document should be able
  to continue without asking a question. If they would have to ask, add the
  answer.

## Step 6 -- Report

First verify that the exact file exists and is readable. Then print the temporary
document path and the continuation prompt so the user can copy it immediately.
Do not stage, commit, push, or submit the handover artifact. End the turn after
this report; a handover is never followed by resumed implementation.

## Hard rules

1. Read git state (Step 1) before writing a word -- never hand off from memory.
2. Never write a secret value into the handover (Step 5). Name the config key.
3. Cite specifics -- `file:line`, function, command, SHA. A handover without
   them is worse than none.
4. State the pause type and exact pause point at the top; it is the highest-value
   line.
5. Keep a single-repository handover under the current project-role workspace's
   `.tmp/handoffs/`; never stage, commit, push, or submit it.
6. Treat invocation as a terminal stop boundary: after it, do only state
   collection, todo reconciliation, artifact writing, and the final report.
7. One failed state read cannot deadlock the artifact. Label the exact fact
   `unverified`; never invent it, omit the failure, or continue implementation.
8. A handover succeeds only after a real file write and read-back verification.
   An inline summary or durable todo alone is not a completed handover.

## Failure modes

- **Vague summary** -- "continued the refactor" tells the next session nothing.
  Name the file, the function, and the next edit.
- **Stale on resume** -- if resuming later, the branch may have moved. The
  continuation prompt names the branch and the doc names the base commit, so the
  next session can check `git log` against them before trusting the plan.
- **Leaked secret** -- writing an RPC URL or token into the doc. Step 5 catches
  it; treat a miss as a serious error.
- **Tracked handover** -- staging or committing the temporary file pollutes
  feature history. Keep it untracked beneath the project-role workspace's
  `.tmp/handoffs/`.
- **Wrong workspace anchor** -- a single-repository handover placed in its
  parent workspace, a global home `.tmp`, `/tmp`, or inline is no longer owned
  by the current project-role workspace. Keep it in that workspace. For genuine
  cross-repository work, use the session's shared project-role workspace rather
  than one arbitrary participant.
- **Read deadlock** -- one repository status read is blocked, so the agent keeps
  working or refuses to write anything. Stop work, mark only that state
  `unverified` with the exact error, and write the remaining truthful handover.
- **Inline-only substitution** -- the agent prints a summary but creates no
  artifact. This is failure, not a handover; report the write blocker and stop.
- **Post-handover continuation** -- the agent writes or discusses the handover
  and then resumes implementation. Invocation ended the work session; do not
  continue.
