# 01. Build classified dynamic workflows and Zellij workers for Pi

- Status: Accepted
- Date: 2026-07-16
- Issue: None (personal configuration change; no tracker issue)

## Context

Pi's deliberately small core does not provide first-class subagents, dynamic
workflows, or Claude Code's Auto Mode classifier. Delegation has two distinct
shapes. A few independent tasks need visible, low-ceremony workers whose answers
return directly to the parent. Broader tasks need the Claude Code dynamic-workflow
model: the parent writes task-specific JavaScript that composes agent calls,
parallel fan-out, verification, and synthesis instead of translating every request
into a fixed workflow schema.

The dynamic runtime and classifier form one security-sensitive lifecycle. A
workflow must be classified when it spawns an agent, every tool action must pass
through the permission engine, and the agent result must be classified before it
returns to the workflow script. Missing any boundary permits work that was approved
for one purpose to acquire capabilities or disclose context at another boundary.

The reviewed off-the-shelf packages do not provide this invariant when composed:

- `@quintinshaw/pi-dynamic-workflows` 2.14.0 provides model-authored JavaScript,
  in-memory Pi agents, budgets, journaled resume, verification helpers, model
  routing, and a run navigator, but it does not own an Auto Mode classifier at all
  four workflow boundaries.
- `@czottmann/pi-automode` 1.7.0 provides a fail-closed `tool_call` classifier, but
  it does not classify dynamic-agent spawn and return. Its read-only fast path also
  does not enforce this configuration's absolute credential-file prohibition.
- Loading both packages can classify many tool actions, but cannot make complete
  spawn/action/return coverage an invariant of the workflow runtime.

Zellij is already the user's terminal session manager. Version 0.44.3 exposes the
primitives needed for lightweight workers without tmux or another extension:
creating named tabs and panes returns stable IDs, pane state and exit status are
available as JSON, and a completed pane's plain scrollback can be dumped by ID.
Pi's non-interactive mode can run an ephemeral, named, tool-restricted worker in
each pane.

The system crosses several trust boundaries:

- user requests become model-authored JavaScript;
- the JavaScript invokes fresh Pi sessions with coding tools;
- prompts, tool calls, and agent results cross a separate classifier-model boundary;
- subagents can read or modify the working tree and consume subscription quota;
- optional worktree isolation executes Git operations and creates branches.

The protected assets are repository and Git state, files outside the requested
scope, credentials, private context captured in prompts or results, and bounded
model usage. The relevant threats are privilege escalation through subagent tools,
prompt injection through tool output or agent results, tampering with shared or Git
state, disclosure through classifier input or persisted results, denial of service
through unbounded agents or tokens, and misleading attribution when a cached,
blocked, or failed subagent result is treated as current.

## Decision

Provide two explicit delegation modes. The user may choose either mode; otherwise
the parent selects the least powerful mode that fits the task.

Use native Zellij workers for a small set of independent tasks that need no shared
state, dependency graph, automatic retry, or cross-agent control flow. Launch them
in a named worker tab as ephemeral `pi --print --no-session` processes. Record every
returned pane ID, inspect its structured exit state, and collect the final plain
text with `dump-screen --full`. Workers are read-only by default through Pi's exact
`read,grep,find,ls` tool allowlist. Keep the panes visible after collection so the
user can inspect or close them as part of the normal Zellij session.

Build a local `pi-classified-workflows` extension for fan-out/fan-in, multi-step
dependencies, cross-checking, bounded loops, or synthesis. The extension
will expose a `workflow` tool that evaluates task-specific JavaScript in a
deterministic Node `vm` realm with no imports, filesystem or network APIs,
wall-clock time, or randomness. The script receives structured orchestration
capabilities such as `agent`, `parallel`, and checkpoints; it never receives Pi
sessions or coding tools directly. The VM limits accidental script capabilities
but is not presented as a security sandbox.

The extension owns one fail-closed permission engine and enforces the complete
classified-agent lifecycle:

1. Before `agent(...)` creates a Pi session, a dedicated classifier decides whether
   the resolved prompt, model tier, tools, limits, and working directory are aligned
   with the user's request and current project instructions.
2. Dynamic agents receive only an explicit registry of wrapped tools. Every tool
   call passes through deterministic deny and allow rules and, when not decided
   deterministically, the classifier before the underlying tool can execute.
   Child sessions do not inherit unwrapped extension tools.
3. Every tool result is classified before it returns to the acting model. Blocked
   output is replaced with the classifier reason rather than leaked into context.
4. Before an agent result becomes visible to the workflow script or parent, a
   dedicated return classifier decides whether it is safe, relevant, and free of
   instructions or data that should not cross the boundary. A blocked return is a
   typed failure containing only the classifier reason.

The same permission engine registers a global Pi `tool_call` hook so ordinary Pi
sessions receive Auto Mode behavior too. It applies explicit deny rules first,
safe deterministic rules second, and the classifier to unresolved actions. It
never asks the acting model to approve its own operation. Classifier failures,
missing models, malformed responses, timeouts, and unavailable auth all block the
operation.

Use `openai-codex/gpt-5.4-mini` as the default classifier through the existing
ChatGPT subscription. Classifier prompts include the user's visible requests and
loaded project instructions but omit tool-result bodies for action decisions. The
return classifier receives only the result being adjudicated plus the minimum
request and policy context needed to decide it. Classifier input/output logging and
classifier session persistence remain disabled.

Add deterministic credential-path guards before every model decision. They block
access to `.env*`, credential stores, private keys, certificates, and other
plausible secret-bearing paths through read, write, edit, grep, find, list, and
shell tools. Broad searches must carry explicit exclusions. These rules are
stricter than Claude Code's defaults and cannot be weakened by repository-local
configuration.

All workflow runs require explicit concurrency, per-agent timeout, retry, total
agent, and token limits. Workflow state is deliberately ephemeral; the parent
receives only the final script value or a typed failure.

Add an explicit `/goal <condition>` command for work that should continue until a
verifiable condition is met. Persist only the goal condition and counters in Pi's
session entries. After every settled agent run, a separate small classifier sees
the condition and user/assistant transcript without tools. An unmet result queues
the evaluator's reason as the next turn; a met result clears the active goal; an
unavailable or malformed evaluator pauses the goal instead of looping blindly.

Add a local `pi-delegation` skill that governs mode selection and both protocols.
It preserves free-form workflow generation while requiring the smallest sufficient
limits, read-only parallel fan-out by default, verification before synthesis, and
checkpoints before consequential mutations.

Do not let parallel Zellij or workflow agents edit a shared tree. Code-changing
workers use the repository's approved worktree workflow and `.worktrees/` layout.
Zellij replaces tmux for Pi sessions and visible workers, but is not treated as a
security boundary.

Test the lifecycle at its boundaries before implementation: spawn allow/block,
every wrapped tool allow/block, return allow/block, classifier failure, timeout,
malformed response, credential-shaped paths, broad searches without exclusions,
bounded concurrency and quota, cancellation, goal state transitions, and the
absence of an unwrapped child tool path. Nushell tests separately cover `f clanker` selecting Pi
by default and Claude only when `--claude` is present.

## Alternatives Considered

### Compose the reviewed workflow and Auto Mode packages

- Pros: Reuses mature orchestration and permission implementations with active
  tests and release histories.
- Cons: Neither package owns the whole classified-agent lifecycle. Spawn and return
  remain outside the permission invariant, and credential reads can use a read-only
  fast path.
- Rejected because: Partial classification does not meet the requested Claude Code
  workflow behavior.

### Fork the workflow package and bolt on the classifier package

- Pros: Retains the existing workflow TUI, journal, helpers, and model routing.
- Cons: Carries two third-party architectures and their update surfaces while still
  requiring invasive lifecycle and tool-registry changes. Correctness would depend
  on upstream internals that are not designed as a classifier boundary.
- Rejected because: The central invariant should be expressed by one local domain
  abstraction rather than maintained as a patch across independent packages.

### Implement all delegation only as Zellij panes

- Pros: Visible processes, native fit with the existing terminal multiplexer, and
  straightforward manual inspection.
- Cons: No structured result channel, deterministic replay, shared budget,
  automatic synthesis, or reliable lifecycle cleanup; pane management is not agent
  isolation.
- Rejected because: Zellij is the right lightweight worker and session layer, but
  it does not supply the dynamic orchestration semantics required for larger tasks.

### Use only deterministic permission rules

- Pros: Fast, cheap, reproducible, and easy to test.
- Cons: Static command patterns cannot reliably decide whether a consequential
  action is aligned with the user's conversational intent or whether a subagent
  result is safe to return.
- Rejected because: Deterministic guards are necessary for hard prohibitions but do
  not provide the requested intent-aware Auto Mode behavior.

## Consequences

Pi gains low-ceremony visible workers, free-form dynamic workflows, and an Auto
Mode permission system without bloating its base system prompt. The lifecycle
invariant is testable in one extension, and the main Pi session and lightweight
workers fit the user's existing Zellij lifecycle.

The local extension is a meaningful security and maintenance surface. It must own
session lifecycle, concurrency, cancellation, usage accounting, classification,
tool wrapping, deterministic script execution, and goal continuation. Changes
to any boundary require threat-model and regression-test review. Model-based
classification adds subscription usage and latency and remains a guardrail rather
than an operating-system sandbox.

Functional parity does not reproduce Anthropic's server-side tool-result probe or
make Pi identical to Claude Code internally. It does provide the locally enforceable
behavior requested here: classification at dynamic-agent spawn, every action, and
return, with fail-closed handling and stricter credential protections.

Parallel edits cannot share the main working tree. They either fan out read-only
and apply edits centrally or use the repository-approved worktree mechanism.
Zellij worker panes retain visible output until the user closes them. Goal state is
session-local and stores no classifier transcript.
