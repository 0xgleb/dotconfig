# 07. Unify Pi scheduling and supervision in a durable local job control plane

- Status: Proposed
- Date: 2026-08-01
- Issue: None (personal orchestration architecture)

## Context

Pi currently has several correct but disjoint lifecycle mechanisms:

- `classified-workflows` owns in-memory child processes, background workflow maps,
  recurring-loop timers, cancellation, and session-journal audit snapshots;
- `todo` reconstructs deferred reminders from the session journal and owns another
  timer;
- `agent-registry` already provides a cross-process SQLite store, leases,
  heartbeats, durable requests, and fenced terminal transitions;
- the Telegram message bridge has a separate durable delivery lifecycle;
- dedicated review workspaces remain alive so they can periodically scan for work;
- local Yielduck and Moneymentum staging processes are supervised separately from
  the agent-facing control surfaces.

These components prove the required policies, but their process-local timers and
stores do not form one recoverable runtime. A managed reload cancels an active
workflow and requires a feature-specific recovery path. A process crash loses the
live background-workflow map. Recurring review scans are durable only as a desired
next timestamp in one Pi session, not as a leased job visible to an operator.
Adding retries, backoff, recurring schedules, dashboard controls, and more local
services independently would multiply lifecycle implementations.

The desired end state is a local, server-backed control plane that can answer:

- what work is due, running, retrying, blocked, cancelled, or terminal;
- which worker owns an attempt and whether its lease is still valid;
- what survives a Pi reload or process crash;
- why an attempt stopped and whether retry is safe;
- which signals a SolidJS dashboard and Telegram control surface may observe;
- which exact typed commands those surfaces may request without gaining ambient
  shell, repository, deployment, wallet, or approval authority.

Apalis is the reference for the useful concepts: storage-backed jobs, workers,
leases, attempts, retry policy, scheduled execution, and middleware-like
cross-cutting concerns. It is not a requirement to adopt its Rust implementation
or reproduce a general distributed queue framework.

This record refines the earlier decision in
[`02-pi-agent-registry.md`](02-pi-agent-registry.md) to avoid an always-on daemon
and the narrow bridge decision in
[`03-metagenda-pi-message-bridge.md`](03-metagenda-pi-message-bridge.md). Their
least-authority, typed-transition, fencing, and bounded-data constraints remain in
force; their intentionally disjoint persistence and process-local scheduling are
superseded by the evidence and explicit owner direction now available.

## Decision

Build one managed local `pi-control-plane` service with a versioned SQLite store
and a loopback HTTP API. During local development it is supervised by the shared
staging mprocs process; the same executable can later be supervised directly by
launchd without changing its storage or API contract. The SolidJS dashboard,
Pi extensions, the Telegram bridge, and constrained local CLIs are clients. They
do not import the SQLite schema or become schedulers themselves.

### Minimal persisted runtime

The service owns four related records behind typed domain operations:

- **Job** — stable identity, registered kind, bounded typed payload, desired state,
  schedule, retry policy, idempotency key, creation/update timestamps, and latest
  terminal summary.
- **Attempt** — monotonic attempt number, worker and lease token, start/finish
  timestamps, heartbeat, bounded outcome, and usage metadata.
- **Event** — append-only bounded lifecycle facts for audit and dashboard timelines;
  the current Job and Attempt rows remain the source of truth.
- **Worker** — session/process identity, supported registered job kinds, policy and
  runtime version digests, heartbeat, and expiry.

Job state is a discriminated union rather than freely combinable columns:
`scheduled | ready | leased | retry_wait | succeeded | failed | cancelled`.
Cancellation may be requested while leased, but a stale worker cannot publish a
terminal result after its lease token has expired or been replaced. Lease expiry
moves the job through one explicit abandoned-attempt transition before it becomes
eligible for retry. Every transition is transactional and validated against the
current state, attempt number, and lease token.

Execution is at least once. Job creation supports a unique `{kind,
idempotencyKey}` where a caller needs deduplication, but handlers still own
side-effect idempotency. The runtime never claims exactly-once execution.

A registered retry policy contains maximum attempts, base delay, multiplier,
maximum delay, and bounded jitter. The chosen `runAt` is persisted when retry or
recurrence is scheduled; workers do not independently recompute it after restart.
Recurring review duty uses a two-hour base with plus-or-minus-one-hour jitter.
A recurring job schedules its successor transactionally when its attempt reaches a
terminal state, so a crash cannot silently lose the recurrence or create an
unbounded duplicate series.

### Registered handlers, not arbitrary remote execution

The service stores only reviewed job kinds and validated payloads. It never stores
or executes shell strings, arbitrary JavaScript, model-authored commands, tool
arguments, credentials, or approval tokens.

Pi processes remain the workers for policy-sensitive agent jobs. A worker claims a
supported job, then invokes the existing typed local implementation:

- review polling becomes a recurring `review-duty.scan` job;
- a classified workflow becomes a `classified-workflow.run` job whose payload is
  the already-bounded workflow request and limits;
- deferred todo wakeups become `todo.wake` jobs;
- bridge delivery and registry requests retain their distinct domain semantics but
  publish lifecycle events through the shared control plane.

Arbitrary model-authored workflow JavaScript cannot be resumed instruction by
instruction after a crash. The persisted unit is one workflow attempt. A crash or
managed reload abandons that attempt and applies its explicit retry policy. Child
audits and terminal evidence remain persisted, and any finer-grained resumability
must come from reviewed structured job kinds with idempotent checkpoints—not from
serializing closures or replaying unknown side effects.

The existing classifier remains authoritative at every spawn, tool action, tool
result, and agent return. A job lease proves ownership of work only; it grants no
project capability or mutation authority.

### Cross-harness executor adapters

External subscription harnesses are executors behind registered adapters, not
control-plane workers with ambient queue access. A Pi supervisor claims the typed
job and invokes one source-fixed adapter. The job payload identifies a reviewed
task family, harness lane, bounded repository/PR/head identity, and resource
limits; it never contains a shell command, free-form prompt, environment map,
credential, approval token, or model-authored tool arguments. The adapter builds
its argv and prompt from trusted local templates.

The first lanes are the existing visible Claude Code Max review harness and
read-only Cursor review probes. Claude remains reachable only through the
source-fixed `jf clanker --claude --new` subscription route. Cursor starts only
after its installed CLI reports the expected subscription-backed identity and
uses a registered model, plan mode, sandboxing, an exact workspace, and no shared
working-tree mutation. Cursor mutation remains disabled until an isolated,
repository-approved worktree contract and cleanup provenance are separately
proven. API keys, custom endpoints, blanket force/yolo flags, arbitrary plugins,
and MCP auto-approval are prohibited in both job data and adapter construction.

Executor output is untrusted data. Each adapter returns one bounded versioned
handoff with input identity, output identity, status, evidence references, and
executor provenance. The Pi supervisor independently verifies repository state
and passes consequential review output through native Fable or Sol verification
before publication, mutation, or merge gates. Missing, malformed, stale, or
mismatched handoffs fail the attempt; model prose never chooses a lane or grants
authority.

Lane selection is deterministic from the registered task's required capability,
repository policy, isolation requirement, verified subscription availability, and
bounded cost tier. It prefers the cheapest eligible lane but reserves Pi capacity
for classification, registry, Telegram, and final gates. UI and event records show
only source-owned task labels, lane/model identity, lifecycle counts, and bounded
sanitized evidence—not prompts, reasoning, credentials, or raw executor logs.

### API and dashboard boundary

The service exposes a versioned loopback API with bounded JSON schemas:

- read models for jobs, attempts, workers, schedules, and event timelines;
- server-sent events for live status updates;
- typed commands for cancellation, retry, pause/resume, and schedule changes;
- health and schema/runtime-version diagnostics.

The first SolidJS dashboard is read-only except for commands that already have an
explicit constrained tool and classifier boundary. It renders server state and
never owns timers, retry calculations, leases, or job transitions. Browser access
is loopback-only. Cross-origin requests, unknown protocol versions, unbounded
payloads, and unregistered job kinds fail closed.

Telegram communication remains message-only by default. A future dashboard or
Telegram control action must map to one reviewed typed command; authenticated text
alone is not authority and cannot become an arbitrary job payload.

### Service supervision and rollout

The shared local staging supervisor becomes the operator-facing process boundary:
it runs Yielduck, Moneymentum, the control-plane service, and the SolidJS dashboard
under one mprocs configuration. Once that staging configuration is extended, its
mprocs pane moves into its own Zellij tab. Agent review panes remain in their
current dedicated observation layout and interact with the service as workers.

Migration proceeds in vertical slices while old paths remain compatibility
adapters:

- introduce the store contract, SQLite schema, state machine, lease fencing, and
  contract tests without moving any handler;
- move recurring review scans onto persisted jobs while `/loop` reads and writes
  the new schedule through an adapter;
- move background workflow ownership and cancellation while preserving the
  existing `workflow` tool and audit output;
- move todo reminders and bridge lifecycle events;
- add the read API and dashboard before enabling any new control mutation;
- remove process-local schedulers only after reload, crash, duplicate-claim,
  cancellation, and retry tests prove parity.

## Alternatives Considered

### Continue adding feature-specific timers and journal records

- Pros: Small local diffs and no new service process.
- Cons: Reload, crash recovery, retry, cancellation, observability, and dashboard
  semantics remain duplicated and inconsistent; background workflows still lose
  their live owner map.
- Rejected because: The owner explicitly requires one generalized durable runtime,
  and the existing number of independent lifecycle implementations is already the
  evidence that another timer is the wrong seam.

### Extend the registry SQLite adapter but keep every Pi process as a scheduler

- Pros: Reuses proven transactions, leases, permissions, and migrations without a
  daemon.
- Cons: Every client still polls, schedules, performs recovery, and coordinates
  schema rollout; the dashboard would either import storage internals or require a
  second API process.
- Rejected because: Shared persistence alone does not provide the requested
  server-backed control plane or single supervision boundary.

### Adopt Apalis directly as a Rust queue service

- Pros: Mature job, worker, retry, and storage abstractions; less conceptual design
  work.
- Cons: Introduces a second implementation language and runtime into TypeScript Pi
  extensions, while policy-sensitive workflow execution and Pi session APIs still
  require custom integration. Its general broker/storage abstractions exceed the
  local single-host requirement.
- Rejected because: Apalis is the architectural reference, but the useful subset is
  smaller than the integration and operational cost of adopting the framework.

### Wait for event-sorcery and move all lifecycle state there

- Pros: Aligns with a richer event-oriented architecture and may suit future remote
  operation.
- Cons: Available TypeScript integration and the final operational contract remain
  uncertain; waiting leaves current reload and scheduling failures unfixed.
- Rejected because: A typed store and API preserve a future adapter seam without
  blocking on an unavailable dependency.

### Put scheduling and control into Metagenda or a project service

- Pros: Reuses an existing bot/service process and may simplify one deployment.
- Cons: Couples global Pi lifecycle to one application repository, broadens a
  network-facing trust boundary, and makes agent runtime upgrades depend on a
  product service.
- Rejected because: Pi coordination is local platform infrastructure; Metagenda,
  Yielduck, and Moneymentum should be clients and supervised siblings, not owners
  of the runtime.

### Let each external harness consume the queue directly

- Pros: Fewer supervisor steps and each vendor can manage its own session lifecycle.
- Cons: Gives vendor processes durable queue credentials, duplicates lease and
  policy handling, weakens subscription/API provenance, and lets untrusted output
  sit too close to terminal transitions.
- Rejected because: External harnesses are execution claims, while Pi owns typed
  authority, independent verification, and the final fenced transition.

### Store prompts or command lines as generic jobs

- Pros: One generic executor can run every future task without new schemas.
- Cons: Turns persisted model text into executable control flow, leaks sensitive
  context into storage/UI, and makes least-privilege review impossible.
- Rejected because: The control plane exists to centralize typed lifecycle, not to
  create a durable remote-shell or prompt queue.

## Consequences

Pi gains one explicit local runtime boundary instead of accumulating timers and
stores. Review scans, workflows, reminders, workers, retries, cancellation, and
dashboard state can share lease and event semantics while retaining their existing
typed policy boundaries.

The service becomes infrastructure that must be migrated and supervised carefully.
Its schema, API, and registered job-kind payloads are compatibility surfaces.
SQLite corruption, service unavailability, clock changes, lease expiry, stale
workers, duplicate enqueue, replayed terminal writes, managed reload, and version
drift require typed failures and integration tests.

The architecture adds a daemon earlier than ADR 02 and ADR 03 originally allowed.
That cost is now justified by the concrete requirement for a SolidJS control panel,
shared staging supervision, recurring review work, and recoverable background
workflows. It does not justify distributed consensus, remote brokers, arbitrary
job execution, or exactly-once claims.

The dashboard can initially ship as a safe observational tool. Consequential
controls remain incremental and auditable because each requires a registered
command, an existing authority source, and a classifier boundary rather than a
generic “run job” endpoint.
