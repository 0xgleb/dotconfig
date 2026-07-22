---
name: handover
description: Prepare a session handover before hitting context or usage limits. Writes a workspace-level temporary handover document under .tmp/ outside every repository in scope (active task, state, files with line refs, recent commits, blockers, exact pause point) and a paste-ready continuation prompt so a fresh session or agent resumes instantly with full situational awareness. Invoke as /handover, or when the user says they are running low on limits and need to hand off.
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
context rediscovery, no lost momentum. Keep the handover outside every Git
repository in scope and never stage or commit it.

Use this when the user is near a context or usage limit, at the end of a long
session, or explicitly asks to hand off. The artifact is two things: a
**handover document** (what happened and exactly where we are) and a
**continuation prompt** (the message to paste into the next session).

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

## Step 2 -- Decide the pause type

- **Mid-implementation pause** -- an edit is started but not compiling/passing,
  or a multi-step change is partway. The handover must name the exact file,
  function, and next line of work so the next session does not re-derive it.
- **Clean boundary** -- the last unit of work is committed and green. The
  handover points at the next task, not a half-finished one.

State which it is at the top of the document. This is the single most useful
line for the next session.

## Step 3 -- Write the handover document

Choose a `.tmp/handoffs/` directory outside every Git repository covered by the
handover:

- Prefer the current workspace root when it is a non-repository parent of the
  repositories in scope.
- For cross-repository work, use the nearest shared parent that is outside all
  covered repositories. Never place the handover inside one arbitrarily chosen
  repository.
- For single-repository work launched from inside that repository, use the
  repository's parent workspace (or a project-defined non-repository workspace
  root), never the Git toplevel itself.

Write to `<workspace>/.tmp/handoffs/YYYY-MM-DD-<slug>.md`, creating the
directory if absent. Treat the file as ephemeral local state: do not add it to
any `.gitignore`, stage it, commit it, or include it in a PR. `<slug>` names the
active task in kebab-case. Use this template, filling every section with
specifics -- file paths, `file:line` refs, command names, commit SHAs. No vague
summaries:

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

Print the temporary document path and the continuation prompt so the user can
copy it immediately. Do not stage, commit, push, or submit the handover artifact.

## Hard rules

1. Read git state (Step 1) before writing a word -- never hand off from memory.
2. Never write a secret value into the handover (Step 5). Name the config key.
3. Cite specifics -- `file:line`, function, command, SHA. A handover without
   them is worse than none.
4. State the pause type and exact pause point at the top; it is the highest-value
   line.
5. Keep the handover under a workspace `.tmp/` outside every repository in
   scope; never stage, commit, push, or submit it.

## Failure modes

- **Vague summary** -- "continued the refactor" tells the next session nothing.
  Name the file, the function, and the next edit.
- **Stale on resume** -- if resuming later, the branch may have moved. The
  continuation prompt names the branch and the doc names the base commit, so the
  next session can check `git log` against them before trusting the plan.
- **Leaked secret** -- writing an RPC URL or token into the doc. Step 5 catches
  it; treat a miss as a serious error.
- **Tracked handover** -- writing inside a repository, staging the file, or
  committing it pollutes feature history. Keep it under the external workspace
  `.tmp/handoffs/` only.
- **Wrong repository scope** -- a cross-repository handover placed inside one
  participating repository falsely makes that repo the owner. Use their shared
  non-repository workspace root.
