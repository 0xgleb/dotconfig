---
name: new-skill
description: Create a new agent skill in this dotconfig repo (~/.config/ai/skills). Handles metadata, drafting the SKILL.md, git commit, and symlink verification for Claude and Cursor.
user-invocable: true
allowed-tools:
  - "Bash(git add *)"
  - "Bash(git status *)"
  - "Bash(git diff *)"
  - "Bash(git log *)"
  - "Bash(git commit *)"
  - "Bash(git push *)"
  - "Bash(test *)"
  - "Bash(ls *)"
  - "Read"
  - "Write"
  - "Edit"
  - "Glob"
  - "Grep"
  - "AskUserQuestion"
---

# New skill creator

Creates a new Claude skill in this dotconfig repo. Skills live in
`~/.config/ai/skills/<name>/SKILL.md` (git-tracked source of truth) and are
reached by Claude through the `~/.claude/skills` symlink and by Cursor through
`~/.cursor/skills`.

## Architecture context

```
~/.config/                      # git repo (source of truth)
  ai/skills/                     # shared agent skills — one subdirectory + SKILL.md each
    eod/SKILL.md
    graphite/SKILL.md
    linear/SKILL.md
    worktree/SKILL.md
  ai/commands/                   # slash commands (Claude + Cursor)
  ai/AGENTS.md                   # global agent guidelines
  ai/claude.settings.json        # Claude Code settings (permissions, etc.)
  ai/cursor.settings.json        # Cursor CLI settings merged into cli-config.json

~/.claude/
  skills -> ~/.config/ai/skills
  commands -> ~/.config/ai/commands
  CLAUDE.md -> ~/.config/ai/AGENTS.md
  settings.json -> ~/.config/ai/claude.settings.json

~/.cursor/
  skills -> ~/.config/ai/skills
  commands -> ~/.config/ai/commands
  AGENTS.md -> ~/.config/ai/AGENTS.md
  CLAUDE.md -> ~/.config/ai/AGENTS.md
  cli-config.json                # local runtime state; preferences merged from ai/cursor.settings.json
```

A skill is a subdirectory containing `SKILL.md` (plus any sibling context
files). Claude auto-triggers a skill when its `description` matches the user's
request; skills marked `user-invocable: true` can also be invoked explicitly.

> Claude slash commands (`~/.claude/commands/<name>.md`) and Codex skills
> (`~/.codex/skills/<name>/SKILL.md`) are real directories **outside** this git
> repo — this skill does not manage them. It creates git-tracked Claude skills
> only.

## Step 1 — Determine the name

Parse `$ARGUMENTS` for the skill name (kebab-case, e.g. `deploy`, `run-tests`,
`linear-api`). This becomes the subdirectory name. If not provided, ask the
user with `AskUserQuestion`.

Before going further, check the name is free:

```bash
test -e ~/.config/ai/skills/<name> && echo "EXISTS — stop and confirm" || echo "free"
```

If it exists, stop and confirm with the user before touching it (Hard rule 2).

## Step 2 — Collect metadata

Batch these into one `AskUserQuestion` where possible:

1. **Description** — one-line summary of *when* this skill should activate.
   This is critical: Claude matches against it to decide whether to trigger.
   Be specific about trigger phrases.
2. **User-invocable** — should the user be able to invoke it explicitly
   (`user-invocable: true`), or is it auto-trigger only? Most explicit
   workflow skills here (`eod`, `linear`) set `user-invocable: true`;
   auto-context skills (`graphite`) omit it.
3. **Allowed tools** — what the skill needs. Suggest based on its job:
   - Read-only research: `Read, Grep, Glob`
   - Code modification: `Read, Edit, Write, Grep, Glob`
   - Shell commands: granular prefix globs, **never blanket `Bash(*)` or
     `Bash(git *)`** — list each command family, e.g. `Bash(git add *)`,
     `Bash(git commit *)`, `Bash(cargo *)`. Match the space-glob style used
     by the existing skills in this repo.

## Step 3 — Draft the content

Ask the user what the skill should do, then draft the full `SKILL.md` following
the conventions of the existing skills in `~/.config/ai/skills/` (read one or
two first for tone and structure):

- Frontmatter as a YAML list for `allowed-tools` (see existing skills).
- Open with a one-line summary of what the skill does.
- Numbered, concrete workflow steps — specific instructions, not vague
  guidance.
- A "Hard rules" section at the end for non-negotiable constraints.
- A "Failure modes" section when there are meaningful error cases.

Show the full draft to the user and iterate until they approve.

### Frontmatter shape

```yaml
---
name: <name>
description: <when this skill should activate>
user-invocable: true        # omit for auto-trigger-only skills
allowed-tools:
  - "Bash(git add *)"        # granular — one family per line
  - "Read"
  - "Write"
---
```

## Step 4 — Create the file

Write `~/.config/ai/skills/<name>/SKILL.md` with the `Write` tool (it creates
the subdirectory). Never write into `~/.claude/skills` directly — that is a
symlink into this repo.

## Step 5 — Verify the symlinks

Confirm the file is reachable through both agent harness symlinks:

```bash
test -f ~/.claude/skills/<name>/SKILL.md && echo "claude linked" || echo "claude NOT linked — investigate"
test -f ~/.cursor/skills/<name>/SKILL.md && echo "cursor linked" || echo "cursor NOT linked — investigate"
```

Then print the file path and a short summary of what was created.

## Step 6 — Commit

Match the repo's existing commit style before writing a message:

```bash
cd ~/.config && git log --oneline -10
```

Stage only the new skill and commit on the current branch:

```bash
cd ~/.config && git add ai/skills/<name>/SKILL.md
cd ~/.config && git commit -m "<message matching repo style>"
```

## Step 7 — Offer to push

State the commit is ready and ask whether to push. Do not push without an
explicit yes:

```
New skill "<name>" created and committed.

  File: ~/.config/ai/skills/<name>/SKILL.md
  Commit: <sha>

Want me to push?
```

If yes, `cd ~/.config && git push`. If no, stop.

## Hard rules

1. Always create skills under `~/.config/ai/skills/`, never directly in the
   `~/.claude/skills` symlink target path or anywhere outside this repo.
2. Never overwrite an existing skill without explicit confirmation. Check with
   `test -e` first (Step 1).
3. **No blanket tool grants.** Never put `Bash(*)` or `Bash(git *)` in
   `allowed-tools`. Enumerate the specific command families the skill needs
   (`Bash(git add *)`, `Bash(git commit *)`, …).
4. Show the full draft to the user before writing the file.
5. Verify both `~/.claude/skills` and `~/.cursor/skills` resolve to the new file after writing.
6. Never push without an explicit per-session yes from the user.

## Failure modes

- **Name collides with an existing skill** — `test -e` in Step 1 catches this.
  Stop and confirm; do not overwrite (Hard rule 2).
- **Symlink check fails in Step 5** — the file exists in the repo but
  `~/.claude/skills/<name>/SKILL.md` or `~/.cursor/skills/<name>/SKILL.md` does
  not resolve. The harness symlinks are broken or missing; report it rather than
  re-creating the file.
- **Description too vague** — the skill won't auto-trigger reliably. Push the
  user for concrete trigger phrasing in Step 2.
