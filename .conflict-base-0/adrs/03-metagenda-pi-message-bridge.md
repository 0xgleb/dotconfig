# 03. Route Metagenda chat through a capability-free Pi message bridge

- Status: Proposed
- Date: 2026-07-23
- Issue: None (personal orchestration architecture)

## Context

Metagenda needs to become the Telegram-facing control panel for the Pi sessions
running on the local workstation. The first slice must discover live sessions,
deliver an authenticated user's text to one selected session, and return that
session's reply. It must not turn a Telegram message into ambient shell, tool,
deployment, wallet, or approval authority.

The existing Pi agent registry is the source of live session identity and role
ownership, but its SQLite schema is an internal coordination adapter. Importing
that schema into Metagenda would couple two independently evolving systems and
let a network-facing bot write ownership records directly. Existing registry
requests are also role-addressed rather than session-addressed, while the user
explicitly wants to communicate with any running Pi instance.

A remote message enters through two trust boundaries: Telegram to Metagenda, and
Metagenda to a live Pi model turn. Even after Telegram user authentication, the
message is untrusted model input. The communication slice therefore needs a
mechanical no-tools invariant, bounded payloads and responses, one-time message
identifiers, expiry, durable outcomes, and a local kill switch. It carries text
and correlation identifiers only; no financial values, credentials, or approval
tokens belong in this protocol.

## Decision

Add a versioned local message bridge beside, but not inside, the registry store.
A managed `pi-bridge` CLI is the only Metagenda-facing boundary. It exposes
bounded machine-readable operations to list bridge-capable live registry
sessions, enqueue one text message for an exact session ID, and read the durable
outcome. Metagenda invokes the executable with an exact argument vector and
passes message text over stdin; it never imports or mutates registry SQLite.

A managed Pi extension shares the bridge store implementation. Each session
heartbeats bridge readiness under its registry session ID, atomically claims at
most one queued message while idle, temporarily replaces its active tool set with
the empty set for the remote turn, and restores the exact prior set afterward.
The extension records the final assistant text or a bounded typed failure against
the correlation ID. Expired, duplicate, stale-session, concurrent, and oversized
messages fail closed. A local disabled flag stops new delivery without affecting
ordinary Pi operation.

Metagenda authenticates the Telegram sender against one configured numeric owner
ID before listing sessions or enqueueing messages. The Telegram bot token is read
from a ragenix-decrypted runtime file, never from Nix evaluation, command-line
arguments, logs, or committed plaintext. Until an owner ID is configured, the bot
may report the sender's own numeric ID but exposes no Pi state.

The bridge protocol is message-only. It does not model approve/reject, invoke a
Pi tool, continue a queued operational action, or derive authority from Telegram.
Consequential remote control, if later justified, requires a separate typed
command protocol and decision record.

## Testable Success Criteria

The implementation starts from these failing tests:

- an unauthenticated Telegram user receives no live-session metadata and cannot
  enqueue a bridge message;
- with no owner configured, the bot can report only the caller's own Telegram ID;
- `/agents` returns only unexpired sessions that currently heartbeat bridge
  readiness, with no raw registry paths or runtime internals beyond the bounded
  display label;
- an authenticated message to an exact live session is delivered once, receives
  one correlated reply, and a duplicate update/message ID does not create a
  second turn;
- the remote turn observes an empty active-tool set, and the exact previous tool
  set is restored after success, model failure, abort, or session shutdown;
- a busy session leaves the message queued until it is idle; expiry produces a
  typed terminal failure rather than late execution;
- message and response size limits, control characters, unknown protocol
  versions, stale sessions, and invalid state transitions fail closed;
- disabling the bridge prevents new claims while ordinary local Pi prompts keep
  working;
- the bot reads the token only from a configured runtime file and never includes
  it in errors, logs, subprocess arguments, Nix store strings, or bridge records.

## Alternatives Considered

### Let Metagenda read and write the registry database directly

- Pros: Few moving pieces and immediate access to live agents.
- Cons: Couples a network-facing process to an internal schema, broadens database
  authority, and makes registry migrations a cross-repository release event.
- Rejected because: Session discovery does not justify allowing the Telegram bot
  to mutate the ownership and request-lifecycle database.

### Give each Pi session a Unix-domain socket

- Pros: Direct delivery and OS filesystem permissions; no polling database.
- Cons: Socket discovery, stale socket cleanup, reconnect behavior, and durable
  result recovery become per-session lifecycle concerns; messages disappear when
  a process exits.
- Rejected because: The first slice needs a small durable lifecycle and audit
  record more than low-latency streaming.

### Reuse role-targeted registry requests

- Pros: Existing durable inbox and owner notification behavior.
- Cons: Sessions without roles are unreachable, a role replacement changes the
  recipient, and operational delegation semantics would be conflated with casual
  chat.
- Rejected because: The user asked to communicate with any selected live Pi
  instance, not to delegate work to whichever session owns a role.

### Start a general local orchestration daemon

- Pros: One long-running API could own discovery, streaming, scheduling, and
  future remote commands.
- Cons: Adds supervision, IPC, upgrades, and a broad authority surface before the
  message contract has operational evidence.
- Rejected because: A narrow CLI plus durable mailbox proves the boundary without
  prematurely building Metagenda's eventual full control plane.

## Consequences

Pi gains a second small local store and polling loop, and the CLI/extension
protocol becomes a compatibility surface with explicit versioning and contract
tests. Tool restoration and session shutdown paths require careful testing because
active tools are process-global session state.

Metagenda stays independent of Pi's storage adapter and can later replace the CLI
with an event-sorcery adapter without changing Telegram command semantics. The
first release is intentionally less powerful than a remote-control bot: it can
communicate and observe delivery, but it cannot authorize or execute a
consequential action. Adding that power later will require a new decision rather
than silently widening this protocol.
