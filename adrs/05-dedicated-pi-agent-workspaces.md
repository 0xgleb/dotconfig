# 05. Launch dedicated operational Pi agents through typed workspace profiles

- Status: Proposed
- Date: 2026-08-01
- Issue: None (personal orchestration architecture)

## Context

The user wants a long-running ST0x-Technology and rainlanguage PR-duty agent that remains visible in a dedicated `st0x` Zellij tab. It must continuously review the user's own PRs, prepare draft inline-only reviews for assigned colleagues' PRs, preserve the user's final verdict, and feed verified work into status reporting. A one-shot background workflow can start useful review work, but it does not provide a durable interactive workspace, an operational registry owner, or periodic monitoring.

Direct model-authored shell calls to interactive Zellij actions are the wrong boundary. They can target the user's active terminal, inject uncontrolled commands, lose focus, and expose an unrestricted process-launch surface. The existing agent registry already separates responsibility routing from authority and requires explicit user intent before dedicated agents are launched.

The first profile is local aarch64-darwin only. It carries no monetary values, production authority, credentials, or remote execution capability. Repository-specific `AGENTS.md`, Graphite conventions, review skills, and GitHub permissions remain authoritative inside each repository.

## Decision

Add a managed, typed Pi workspace launcher with a finite profile registry. The first profile is `st0x-review` and fixes all security-sensitive launch inputs in source:

- Zellij tab name `st0x`;
- working directory `/Users/0xgleb/code/st0x`;
- Pi session name `st0x-review-duty`;
- model `openai-codex/gpt-5.6-sol` at high reasoning;
- operational registry role `/Users/0xgleb/code/st0x/reviewer`;
- a source-fixed bootstrap prompt that preserves repository ownership boundaries and review publication policy;
- a bounded recurring instruction that re-scans PR duty without declaring the operational role complete when one sweep is empty.

The launcher invokes Zellij and Pi with exact argument arrays, never through a shell string, and refuses unknown profiles or duplicate live tabs. It may focus the new tab only because the user explicitly requested the dedicated agent. Agent-initiated background launches for other profiles retain the existing exact focus-snapshot-and-restore requirement.

The ST0x agent handles two distinct lanes:

- PRs authored by the user: use each repository's review-loop and delivery conventions, with mutations isolated by repository-approved worktrees where parallel work requires them.
- PRs authored by others and assigned to the user: inspect without checkout or code mutation and create only an empty-body pending draft review containing verified inline comments. Never submit a verdict or top-level review body; the user chooses the final verdict.

A background classified workflow may bootstrap read-only review work while the interactive workspace is being launched, but it never substitutes for the operational agent or gains ownership through the registry.

## Alternatives Considered

### Launch arbitrary commands through `bash` or Zellij keystrokes

- Pros: Minimal implementation and immediate flexibility.
- Cons: Exposes unrestricted process launch, can affect the active pane, depends on shell quoting, and lets model-authored text become executable terminal input.
- Rejected because: A review-duty profile is finite and known; arbitrary command execution is unnecessary and violates the existing Zellij focus and input boundaries.

### Use only one-shot classified workflows

- Pros: Strongly bounded, background-friendly, and easy to audit per review.
- Cons: No visible persistent workspace, no operational role owner, no durable conversational context, and no natural periodic monitoring surface.
- Rejected because: The user explicitly wants a dedicated long-running `st0x` agent and tab, not merely isolated review jobs.

### Run the reviewer as a launchd daemon

- Pros: Automatic restart and independence from the terminal multiplexer.
- Cons: Hides the interactive session, adds supervision and log lifecycle, complicates human verdict handoff, and creates a broader always-on GitHub automation surface.
- Rejected because: A visible Zellij workspace plus operational registry lease is sufficient for the first local reliability slice.

### Give one generic launcher arbitrary profile fields

- Pros: Reusable for every future agent without code changes.
- Cons: Turns cwd, model, prompt, tools, and commands into model-controlled authority and makes validation equivalent to rebuilding a shell policy language.
- Rejected because: Explicit source-fixed profiles are simpler to review and make invalid launch states unrepresentable.

## Consequences

Dedicated agents become explicit managed resources instead of ad hoc terminal commands. The user gets a visible ST0x workspace, durable operational ownership, periodic PR-duty checks, and a clean seam for Telegram status and EOW evidence.

Adding another operational agent requires a reviewed source profile rather than arbitrary launch arguments. The launcher must test duplicate prevention, exact argv construction, profile bounds, and Zellij-unavailable failures. It does not make GitHub review publication automatic beyond the already-authorized draft inline-only policy, and it does not grant repository mutations where project ownership rules forbid them.
