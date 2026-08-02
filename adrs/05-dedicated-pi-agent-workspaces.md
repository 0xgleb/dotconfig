# 05. Launch dedicated operational Pi agents through typed workspace profiles

- Status: Superseded by [ADR 06](06-claude-harness-review-executors.md)
- Date: 2026-08-01
- Issue: None (personal orchestration architecture)

## Context

The user wants a long-running ST0x-Technology and rainlanguage PR-duty agent that remains visible in a dedicated `st0x` Zellij tab. It must continuously review the user's own PRs, prepare draft inline-only reviews for assigned colleagues' PRs, preserve the user's final verdict, and feed verified work into status reporting. A one-shot background workflow can start useful review work, but it does not provide a durable interactive workspace, an operational registry owner, or periodic monitoring.

Direct model-authored shell calls to interactive Zellij actions are the wrong boundary. They can target the user's active terminal, inject uncontrolled commands, lose focus, and expose an unrestricted process-launch surface. The existing agent registry already separates responsibility routing from authority and requires explicit user intent before dedicated agents are launched.

The initial profile is local aarch64-darwin only. It carries no monetary values, production authority, credentials, or remote execution capability. Repository-specific `AGENTS.md`, Graphite conventions, review skills, and GitHub permissions remain authoritative inside each repository.

The owner subsequently required two additional, isolated long-running reviewers rather than one generic owner-review process: one for the DataClique organization and one for repositories owned by the personal `0xgleb` account. Only `dataclique/yielduck` and `0xgleb/dotconfig` may auto-merge after clean convergence and freshly verified merge gates; every other repository retains a human action gate. The existing ST0x/rainlanguage reviewer remains a separate third authority domain.

## Decision

Add a managed, typed Pi workspace launcher with a finite profile registry. Every profile fixes its Zellij tab, working directory, Pi session name, model, operational registry role, bootstrap policy, and bounded recurring scan instruction in source:

- `st0x-review`: tab `st0x`, root `/Users/0xgleb/code/st0x`, session `st0x-review-duty`, and only ST0x-Technology/rainlanguage review duty;
- `dataclique-review`: tab `dataclique-review`, root `/Users/0xgleb/code/dataclique`, session `dataclique-review-duty`, and only DataClique-owned repositories;
- `personal-review`: tab `personal-review`, root `/Users/0xgleb/code/0xgleb`, session `personal-review-duty`, and only `0xgleb`-owned repositories, with the dotconfig checkout explicitly located at `~/.config`.

All use `openai-codex/gpt-5.6-sol` at high reasoning and an operational `reviewer` role rooted in their authority domain. An empty scan never completes an operational role.

The launcher invokes Zellij and Pi with exact argument arrays, never through a shell string, and refuses unknown profiles or duplicate live tabs. It may focus the new tab only because the user explicitly requested the dedicated agent. Agent-initiated background launches for other profiles retain the existing exact focus-snapshot-and-restore requirement.

Every reviewer handles two ordinary lanes:

- PRs authored by the user: use each repository's review-loop and delivery conventions, with mutations isolated by repository-approved worktrees where parallel work requires them.
- PRs authored by others and assigned to the user: inspect without checkout or code mutation and create only an empty-body pending draft review containing verified inline comments. Never submit a verdict or top-level review body; the user chooses the final verdict.

A typed review-duty state machine gates every review workflow. Ordinary own and assigned jobs cannot advance until one exact verdict/action question is persisted and Telegram-linked. The two exact automatic lanes use a distinct `auto` kind and may clear the workflow gate without a user verdict only after a completed workflow is proven; this does not itself prove merge safety. The reviewer must freshly verify unchanged head SHA, required CI, mergeability, unresolved feedback, and repository delivery policy immediately before merging. No other repository can enter the automatic lane.

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

### Collapse DataClique and personal repositories into one owner-review agent

- Pros: One fewer workspace and simpler periodic inventory.
- Cons: Mixes organization and personal authority, makes repository-specific auto-merge policy harder to audit, and lets one stale or compromised session span both ownership domains.
- Rejected because: The owner explicitly chose two isolated reviewers, and the separate roots make authority, dedupe, operational ownership, and incident containment reviewable.

### Give one generic launcher arbitrary profile fields

- Pros: Reusable for every future agent without code changes.
- Cons: Turns cwd, model, prompt, tools, and commands into model-controlled authority and makes validation equivalent to rebuilding a shell policy language.
- Rejected because: Explicit source-fixed profiles are simpler to review and make invalid launch states unrepresentable.

## Consequences

Dedicated agents become explicit managed resources instead of ad hoc terminal commands. The user gets a visible ST0x workspace, durable operational ownership, periodic PR-duty checks, and a clean seam for Telegram status and EOW evidence.

Adding another operational agent requires a reviewed source profile rather than arbitrary launch arguments. The launcher must test duplicate prevention, exact argv construction, profile bounds, and Zellij-unavailable failures. Typed review-duty policy must reject cross-owner jobs and reject `auto` for every repository except Yielduck and dotconfig. It does not make GitHub review publication automatic beyond the already-authorized draft inline-only policy, and it does not grant repository mutations where project ownership rules forbid them.
