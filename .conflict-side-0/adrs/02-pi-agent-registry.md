# 02. Coordinate Pi agents through local exclusive role leases

- Status: Proposed
- Date: 2026-07-22
- Issue: None (personal configuration architecture)

## Context

Several interactive Pi sessions may be active across unrelated repositories. A
project agent currently has no reliable way to discover that another session owns
Pi configuration support, staging operations, or another long-running duty. It may
duplicate work, leave a handoff in a location nobody watches, or assume an operator
exists when it does not. Conversely, a session performing operational work may
incorrectly declare itself done merely because its finite todo list is empty.

The desired coordination contract is local and deliberately small:

- each `{project, role}` has at most one live owner;
- one agent may own several project-role pairs;
- an unowned role is temporarily self-claimed by the requesting agent by default;
- a dedicated Zellij operator is launched only when the user explicitly requests
  one;
- registry ownership routes responsibility but grants no authority;
- actual authority comes from project-specific, time-versioned, constrained tools
  and loaded instructions;
- operational roles remain active through an empty inbox and have no automatic
  "done" state;
- manual interruption pauses work without silently releasing its role;
- the model and policy will evolve, so failures and revisions must be observable
  rather than hidden behind a supposedly final trust model.

This is security-sensitive for projects such as Yielduck. A staging operator may
ship reviewed code through its existing release surface and operate a supervised
bot funded by a test wallet, while remaining unable to read wallet credentials or
perform manual wallet operations. A future production operator may receive narrow
read-only diagnostics and an explicit circuit-breaker tool, but no unrestricted
SSH, database, signing, secret, or direct-fix capability. The registry must not
turn a role name into any of those permissions.

The first target is local aarch64-darwin Pi sessions under Zellij. Remote and
multi-host coordination is not yet justified. The persistent protocol contains no
financial values or units; project operator tools retain responsibility for their
own typed amounts, scales, and money-safety invariants.

## Decision

Build a managed Pi extension that exposes a typed `agent_registry` tool, commands,
and a persistent status widget. Use Effect where typed errors, schedules, retries,
concurrency, or scoped resources improve correctness. Keep the on-disk protocol
versioned and locally inspectable.

Put persistence behind an Effect `RegistryStore` service whose contract is typed
in domain operations and outcomes rather than database calls. The first adapter
is a local SQLite file through Node 24's built-in `node:sqlite`, using
`BEGIN IMMEDIATE` transactions and a schema version. Run the same lease,
request-lifecycle, crash, fencing, and policy revision contract tests against every
adapter. If `event-sorcery` 0.5.0 later
ships TypeScript bindings, an event-sorcery adapter may replace file persistence
and heartbeat scheduling without changing the `agent_registry` tool, role policy,
or UI contracts. Do not depend on unreleased bindings or build a private imitation
of event-sorcery now.

Store runtime state outside the dotconfig repository under the user's state root
(`$XDG_STATE_HOME/pi/agent-registry`, falling back to
`~/.local/state/pi/agent-registry`) in `registry.sqlite`. Every ownership and
request transition runs in a bounded SQLite transaction. `BEGIN IMMEDIATE` lets
SQLite serialize cross-process writers and recover locks when a process exits;
there is no age-based userspace lock breaking and therefore no paused writer that
can resume after being fenced out and overwrite a replacement writer. The database
uses a bounded busy timeout, restrictive file permissions, and a schema version;
decoding an unknown version fails closed.

### Identity and exclusive leases

Each Pi session registers an agent identity carrying a random session identifier,
canonical project root, process liveness metadata, model reference for diagnostics,
and heartbeat timestamp. Model identity is observational only and never grants a
capability.

A role key is the canonical project root plus a finite role name. Claiming creates
a lease with a unique lease identifier, owner agent identifier, mode
`task | operational`, policy revision digest, acquisition time, heartbeat time,
and expiry. Claim is atomic: concurrent claimers observe exactly one `claimed`
outcome and typed `already_owned` outcomes naming only safe owner metadata. One
agent may hold multiple leases.

Heartbeats renew leases at a configured cadence shorter than the configured TTL.
A live lease cannot be stolen. An expired lease can be reclaimed atomically. A
session shutdown releases task leases cleanly; crashes rely on expiry.
Operational leases do not release because their inbox is empty or their todos are
complete. They end only through explicit release, session shutdown, or expiry.
Manual user cancellation records the owner as paused and stops heartbeating. This
preserves a bounded redirect window without restarting work; the next user prompt
resumes heartbeat if the lease is still live, while an abandoned paused session
naturally expires and becomes reclaimable.

A lease binds the exact project policy revision. Any policy digest change suspends
the lease and requires re-claim under the new revision. This intentionally treats
both restriction and expansion as a review boundary rather than trying to infer
whether an arbitrary policy diff is privilege-increasing. Better future models do
not silently widen an existing lease.

### Durable role inboxes

Delegation writes a request with a unique request identifier to the target role's
inbox using atomic rename. Request state is a discriminated union:

- `queued` -- durably accepted but not owned;
- `claimed` -- bound to the current lease identifier;
- `completed` -- carries a bounded result summary and completion time;
- `failed` -- carries a typed failure class and bounded safe diagnostic;
- `cancelled` -- explicitly withdrawn by the requester or user.

A requester never assumes delivery from file creation alone. The owner claims the
request, persists the transition, adds its concrete work to branch-aware todos,
and eventually persists a terminal outcome. Request files survive Pi reloads and
process restarts. Stale lease identifiers cannot complete work. If a claimed
request's lease expires or is replaced, the current role owner may atomically
reclaim it. Cancellation, completion, and failure are serialized compare-and-set
transitions: exactly the first valid terminal transition wins and all later
attempts return `invalid_transition`.

When discovery reports `unowned`, the current project agent temporarily claims the
role and handles the immediate request itself. The extension never automatically
launches another Pi process. Explicit user-requested spawning may focus the new
agent. Agent-initiated background spawning may use the main Zellij session only
after snapshotting the user's active tab and pane, and must restore and verify that
exact focus before returning; otherwise it falls back to a classified background
workflow.

### Authority and project policy

The registry advertises bounded capability names and a policy revision for routing
and UI only. Capability enforcement remains in registered, project-specific tools
and loaded project instructions. Every constrained operator tool validates the
current lease ID, owner, unexpired status, and exact policy digest immediately
before its consequential action; discovery at prompt time is never authorization.
The registry never exposes raw shell, SSH, database, signing, wallet, credential,
or deployment authority.

Project policy may evolve over time and may differ by role. Representative policy
profiles are deliberately not global defaults:

- a Yielduck staging operator can receive reviewed release and supervised-bot
  tools while wallet credentials remain inaccessible through 1Password;
- a future Yielduck production operator can receive selected read-only queries,
  selected remote-file reads, and a circuit-breaker tool while code changes still
  follow review and release procedures;
- Pi configuration support can edit, test, commit, push, reload, and report managed
  configuration without inheriting unrelated project authority.

### Operator questions and signals

The extension must answer four operator questions with one signal each:

1. **Who owns this role, and is the owner live?** The `/agents` registry snapshot
   and persistent status widget show the typed lease state and heartbeat age.
2. **Where is a delegated request stuck?** Its durable request lifecycle record is
   the single source for queued, claimed, and terminal state.
3. **Why did ownership stop being valid?** The lease carries one typed suspension
   or expiry reason, including policy revision mismatch.
4. **Did a background Zellij launch return control correctly?** The launch result
   records one typed `focus_restored | focus_restore_failed` outcome; failure is
   visible and stops further pane automation.

Identifiers remain fields in local records, not metric labels. Records and UI must
never include secrets, credential paths, raw command output, or financial amounts.

## Testable Success Criteria

The implementation starts from these failing tests:

- two processes concurrently claiming the same `{project, role}` produce exactly
  one live lease and one `already_owned` result;
- one agent can atomically hold two different project-role leases without either
  weakening the other's exclusivity;
- a heartbeat prevents reclaim before TTL, while a crashed owner's expired lease
  is reclaimed by exactly one contender;
- a live writer holding a transaction cannot be fenced out by elapsed wall time,
  while a killed writer releases SQLite ownership and cannot publish afterward;
- an unowned role is temporarily self-claimed without creating a Zellij pane;
- no code path launches a dedicated operator unless the visible user request
  explicitly asks for one;
- an agent-initiated background launch restores the exact prior tab and pane, and
  a failed restoration yields `focus_restore_failed` and stops automation;
- a queued request survives extension reload, is claimed only by the current
  lease, becomes a todo, and reaches one durable terminal state;
- a request claimed by an expired lease is reclaimable by the replacement owner,
  while a stale lease cannot complete it;
- racing cancel and complete transitions produce one terminal winner and one typed
  `invalid_transition`, never conflicting terminal records;
- an operational lease remains live when its inbox and todo list are empty;
- manual double-cancel pauses continuation and heartbeat without immediately
  releasing the operational lease; the next prompt resumes a still-live lease,
  while an abandoned pause expires;
- a policy digest change suspends the old lease and no tool invocation proceeds
  under the new policy until re-claim;
- claiming a role does not add tools or authorize an otherwise forbidden action;
- a constrained operator tool refuses at its invocation boundary after lease
  expiry, ownership replacement, suspension, or policy digest change;
- representative staging and production policies prove staging release tools can
  coexist with denied wallet access, and production circuit breaking can coexist
  with denied raw SSH, unrestricted database access, and direct deployment;
- a killed writer leaves either the previous committed SQLite transaction or the
  complete next transaction, never partial registry state;
- `/agents` and the persistent widget answer owner, liveness, pending-request, and
  suspension questions from state alone.

Each external assumption is validated concretely: atomic claim, SQLite transaction
recovery, fencing, and crash recovery through multi-process tests; Zellij focus
behavior through an isolated-session spike against structured tab/pane state; Pi
reload persistence through RPC
integration; project authority through tool-level allow/deny tests rather than
role-name assertions; and storage portability by running one `RegistryStore`
contract suite against the SQLite adapter and any future event-sorcery adapter.

## Non-goals / Out of Scope

- A launchd daemon, distributed consensus, remote registry, or multi-host lease.
- A dependency on unreleased event-sorcery TypeScript bindings or a local
  reimplementation of its event-store/job runtime.
- Automatic creation of dedicated agents when a role is vacant.
- Shared ownership of one project-role pair.
- Registry-defined RBAC or authority derived from a role name or model name.
- Unrestricted production SSH, database, filesystem, wallet, signer, or secret
  access.
- Bypassing code review, release procedures, risk gates, or project circuit-breaker
  policy.
- Generic production monitoring logic; each project supplies its own observations,
  constrained actions, and escalation rules.
- A promise that an operational model is trustworthy forever. Policy revisions and
  observed failures drive later refinement.
- Remote 24/7 reliability in the first local-extension version.

## Alternatives Considered

### Infer ownership from Zellij panes

- Pros: Minimal persisted state; existing panes are visible to the user.
- Cons: Pane names cannot safely encode leases, policy revisions, request
  acknowledgements, pause state, or crash expiry. Zellij focus and pane lifecycle
  are UI concerns, not an ownership transaction.
- Rejected because: Presence of a pane cannot prove that a role is owned or that a
  request was durably accepted.

### Run a dedicated launchd control-plane daemon

- Pros: A single process could serialize claims, supervise agents, and expose a
  richer event stream.
- Cons: Adds service installation, recovery, version skew, IPC, and another
  always-on failure surface before the local protocol has operational evidence.
- Rejected because: A local SQLite adapter and extension heartbeats can validate
  the ownership contract with much less irreversible machinery.

### Wait for or imitate event-sorcery TypeScript bindings

- Pros: Event-sourced transitions and durable jobs fit lease and inbox lifecycles,
  and would align with Dataclique's existing operational architecture.
- Cons: The bindings are not imminent; waiting blocks current coordination, while
  imitation creates a disposable second event runtime.
- Rejected because: An Effect `RegistryStore` contract preserves a clean future
  adapter seam without taking an unavailable dependency or pre-building it badly.

### Let every project agent coordinate informally

- Pros: No implementation and maximum per-session flexibility.
- Cons: Duplicate work, dropped handoffs, stale assumptions about ownership, and
  operational agents declaring completion remain normal failure modes.
- Rejected because: The current failures already demonstrate that conversational
  convention alone is not durable coordination.

### Encode authority directly in registry roles

- Pros: One apparent source for routing and permissions.
- Cons: A stale lease or innocent role-name change could widen production access;
  model upgrades could be mistaken for authorization; project-specific safety
  boundaries would leak into global infrastructure.
- Rejected because: Discovery and authorization vary independently and must remain
  separate contracts.

## Consequences

Agents gain a small local control plane for exclusive responsibility, durable
handoffs, and non-terminating operator roles. Lean single-agent use remains simple:
an absent owner self-claims and continues. Explicit dedicated operators can be
added without making automatic process creation the default.

The extension becomes a concurrency-sensitive persistence component. It must own
atomic locking, heartbeat scheduling, stale recovery, lifecycle decoding, bounded
diagnostics, and focus restoration tests. Effect can reduce hand-rolled scheduling
and resource-lifecycle risk. The `RegistryStore` service—not SQLite calls—becomes the
internal boundary; the versioned local database remains the first recovery format,
while a future event-sorcery adapter stays possible.

The design deliberately does not solve remote production operations. Its typed
failures and operator questions are intended to reveal whether a later launchd or
remote coordination layer is justified. Because agents are stochastic and model
capabilities change, the policy and protocol are versioned and expected to be
refined from observed behavior rather than treated as permanently complete.
