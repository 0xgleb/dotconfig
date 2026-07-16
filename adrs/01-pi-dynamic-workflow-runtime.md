# 01. Use a pinned Pi dynamic-workflow runtime

- Status: Proposed
- Date: 2026-07-16
- Issue: None (personal configuration change; no tracker issue)

## Context

Pi's deliberately small core does not provide a first-class subagent or dynamic
workflow runtime. The desired behavior is the Claude Code dynamic-workflow model:
the parent agent should write task-specific JavaScript that composes independent
agent calls, parallel fan-out, verification, and synthesis instead of translating
every request into a fixed workflow schema.

This runtime crosses several trust boundaries:

- user requests become model-authored JavaScript;
- the JavaScript invokes fresh Pi sessions with coding tools;
- subagents can read or modify the working tree and consume subscription quota;
- run journals and results are persisted outside the repository;
- optional worktree isolation executes Git operations and creates branches.

The protected assets are repository and Git state, files outside the requested
scope, credentials, private context captured in results, and bounded model usage.
The relevant threats are privilege escalation through subagent tools, tampering
with shared or Git state, disclosure through persisted transcripts/results,
denial of service through unbounded agents or tokens, and misleading attribution
when a cached or failed subagent result is treated as current.

`@quintinshaw/pi-dynamic-workflows` already implements the required Pi-native
runtime. Version 2.14.0 provides model-authored JavaScript, isolated in-memory Pi
sessions, model routing, budgets, journaled resume, verification helpers, a run
navigator, and `/ultracode`. Its orchestration script runs in a Node `vm` realm
without imports, filesystem access, network access, wall-clock time, or randomness.
The project explicitly documents that this realm provides determinism rather than
a security boundary: spawned agents receive Pi coding tools by default. Runs also
have no token budget or hard timeout unless supplied, and its optional worktrees
live under `.pi/worktrees`, which conflicts with this repository's `.worktrees`
convention.

## Decision

Use `@quintinshaw/pi-dynamic-workflows` rather than implementing a second local
orchestration runtime. Pin the exact reviewed package version in the declarative Pi
configuration; updates are explicit review events rather than automatic upgrades.

Add a local `pi-workflows` skill that governs when and how Pi uses the runtime. It
will preserve free-form workflow generation while requiring bounded concurrency,
an agent timeout, an explicit run token budget, read-only parallel fan-out by
default, verification before synthesis, and checkpoints before consequential
mutations. Persisted subagent transcripts remain disabled.

Do not use the package's `isolation: "worktree"` option in repositories whose
instructions require a different worktree layout. In those repositories, parallel
workflow agents remain read-only; code-changing workers use the repository's
approved worktree workflow. Zellij replaces tmux only for visible or interactive
long-running Pi processes and is not treated as the workflow security boundary.

The integration must be covered by configuration tests that fail if the package
version becomes unpinned, safety defaults disappear, or the Pi-only skill is no
longer discoverable. Nushell tests separately cover `f clanker` selecting Pi by
default and Claude only when `--claude` is present.

## Alternatives Considered

### Build and maintain a local Pi extension

- Pros: Full control over tool policies, state layout, worktree paths, and update
  cadence; no third-party runtime dependency.
- Cons: Reimplements a large TypeScript runtime including parsing, deterministic
  replay, concurrency control, cancellation, usage accounting, model routing,
  session lifecycle, worktree cleanup, TUI state, and recovery behavior.
- Rejected because: The existing extension already implements the exact requested
  model with an active test suite and release history. A local fork would create a
  substantially larger unaudited security and maintenance surface for no required
  capability.

### Implement subagents only as Zellij panes

- Pros: Visible processes, native fit with the existing terminal multiplexer, and
  straightforward manual inspection.
- Cons: No structured result channel, deterministic replay, shared budget,
  automatic synthesis, or reliable lifecycle cleanup; pane management is not agent
  isolation.
- Rejected because: Zellij is a good process UI but does not supply the dynamic
  orchestration semantics the user requested.

### Install the extension with its defaults and no local policy

- Pros: Minimal configuration and immediate access to all features.
- Cons: Unbounded token and time usage, broad subagent tools, accidental transcript
  persistence if enabled later, and worktree behavior that can violate repository
  instructions.
- Rejected because: The defaults do not encode this configuration's safety,
  confidentiality, and repository-boundary requirements.

## Consequences

Pi gains dynamic, task-specific multi-agent workflows without bloating its base
system prompt or maintaining a bespoke orchestration engine. The local skill can
evolve workflow policy independently of the pinned runtime, and Zellij remains the
user-facing multiplexer for interactive processes.

The package becomes executable supply-chain code with access to Pi's authenticated
model registry and coding tools. Every version update therefore requires reviewing
its manifest, runtime/tool boundaries, persistence changes, and tests before moving
the pin. The deterministic VM reduces accidental orchestration-script capabilities
but does not contain a malicious or mistaken subagent.

Parallel edits cannot use the package's built-in worktree mode where it conflicts
with repository instructions. Those tasks either fan out read-only and apply edits
centrally, or use the repository-approved worktree mechanism. Full workflow results
remain persisted by the extension even when subagent session transcripts are not,
so sensitive material must not be placed in prompts or returned by agents.
