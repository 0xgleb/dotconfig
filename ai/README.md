# ai/ -- AI Coding Agent Configuration

Shared configuration for AI coding agents. `AGENTS.md` and `skills/` apply to
any agent that follows the AGENTS.md convention (Claude Code, Codex, etc.).
Hooks and `settings.json` are Claude Code-specific.

Managed by home-manager. On `darwin-rebuild switch`, these files are symlinked
into `~/.claude/`:

| Source                | Target                     |
| --------------------- | -------------------------- |
| `ai/AGENTS.md`        | `~/.claude/CLAUDE.md`      |
| `ai/skills/`          | `~/.claude/skills/`        |
| `ai/settings.json`    | `~/.claude/settings.json`  |

## Directory Structure

```
ai/
  AGENTS.md           # Global agent instructions (symlinked as ~/.claude/CLAUDE.md)
  settings.json       # Claude Code-specific settings (hooks, permissions)
  README.md           # This file
  hooks/
    stop-check.nu      # Stop hook -- task handoff protocol (nushell)
    stop-check.test.nu # Tests (run via `nix flake check`)
    unicode-check.nu      # PreToolUse hook -- rejects non-ASCII in edits
    unicode-check.test.nu # Tests (run via `nix flake check`)
  skills/
    graphite/SKILL.md # Graphite (gt) stacked PR management
    worktree/SKILL.md # Git worktree management
```

## Stop Hook Protocol

`hooks/stop-check.nu` runs every time Claude tries to stop. It's built as a
nix wrapper (`stop-check` on PATH via home-manager) and tested via
`nix flake check`. It enforces a handoff protocol so work is never silently
abandoned.

### How it works

1. Claude finishes and tries to stop
2. The hook checks `stop_hook_active` — if already fired this turn, allows stop
   (prevents infinite loops)
3. Otherwise, blocks with instructions telling Claude to introspect on its task
   list

### Decision tree

```
Claude tries to stop
  │
  ├─ Has incomplete non-blocked tasks?
  │    → Commit work, continue on next task
  │
  ├─ All remaining tasks blocked?
  │    ├─ Handoff doc recently changed? (< 5 min)
  │    │    → Read it — check for replies that unblock
  │    │    → If unblocked: update tasks, continue
  │    │    → If still blocked: write blocked entry, commit, stop
  │    └─ No recent changes
  │         → Write blocked entry, commit, stop
  │
  └─ All tasks complete?
       → Write completion entry, commit, stop
```

### Handoff document

Written to `.claude/handoff.md` in the project root. The file is
**prepend-only** — new entries go on top, old entries are never modified. This
creates a reverse-chronological log of session handoffs.

Each entry includes Obsidian dataview metadata:

```yaml
---
repo: dotconfig
branch: feat/my-feature
pr: 42
issue: 15
status: blocked    # or "complete"
timestamp: 2026-03-22T14:30:00Z
---
```

**Blocked entries** include:
- Why the work is blocked (explanation, not just a label)
- Numbered questions with `**Response:**` sections for the user to fill in
- Summary of what was accomplished

**Complete entries** include:
- Summary of what was accomplished

### Responding to a blocked session

1. Open `.claude/handoff.md`
2. Fill in the `**Response:**` fields under each question
3. Start a new Claude session — it will read the updated doc and continue

The stop hook detects recent modifications (< 5 minutes) and prompts Claude to
check for replies before writing a new entry.

## Unicode Check Hook

`hooks/unicode-check.nu` is a PreToolUse hook that runs before every Edit and
Write tool call. It rejects any content containing non-ASCII Unicode characters
(em dashes, arrows, box-drawing characters, etc.). Use ASCII equivalents
instead: `--` for em dash, `->` for arrow.
