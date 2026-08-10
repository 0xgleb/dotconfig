# Remote-control message bridge threat model

## Scope and assets

The first bridge slice carries authenticated-owner chat text from Metagenda into
one selected live Pi session and returns bounded assistant text. It does not
carry approvals, tool calls, credentials, financial values, or operational
authority.

Assets protected by this boundary are:

- the local user's files, processes, goals, todos, credentials, and live-system
  authority exposed through ordinary Pi tools;
- private session context, which must be returned only through Metagenda's
  authenticated Telegram-owner boundary;
- session identity and message correlation, which must not be spoofed or reused;
- Pi availability, tool configuration, and the durability of ordinary local
  prompts.

## Trust boundaries

1. **Telegram → Metagenda:** Telegram updates are untrusted until Metagenda
   matches the numeric sender ID against its configured owner. The token is a
   runtime-file secret and never enters this protocol or the Nix store.
2. **Metagenda → `pi-bridge`:** argv identifiers and stdin text are untrusted.
   They are bounded and validated before entering the typed SQLite lifecycle.
3. **SQLite → Pi extension:** rows may be stale or corrupt. Every field, status,
   timestamp, protocol version, claim transition, and payload is decoded and
   validated fail-closed.
4. **Remote text → model:** even owner-authenticated text remains untrusted model
   input. The extension mechanically replaces the active tool set with the empty
   set before injecting the turn and restores the exact prior set afterward.
5. **Model → Telegram:** assistant output is untrusted data. Only bounded text is
   persisted and returned; it never becomes a tool argument or authorization.

## STRIDE analysis

| Threat | Concrete abuse | Mitigation and evidence |
| --- | --- | --- |
| Spoofing | A different Telegram user or stale process impersonates the owner/session. | Metagenda checks the numeric owner ID; the bridge targets an exact live session ID; owner-only filesystem modes protect the local mailbox. |
| Spoofing | A local process frames a fabricated operational alert as an outward owner relay and the owner reads it as a fleet report. | The dispatch drain delivers a relay only for a sender on the live bridge roster that is not the dispatcher session, and the delivered text names that sender. |
| Tampering | A duplicate, malformed, oversized, expired, or concurrently claimed message changes lifecycle state. | Bounded decoders, requester/dedupe uniqueness, expiry, transactions, one-time claim tokens, and guarded terminal transitions fail closed. |
| Repudiation | A message is delivered twice or its outcome cannot be correlated. | Durable message IDs, requester dedupe keys, timestamps, typed terminal outcomes, and one correlated response make lifecycle state inspectable. |
| Information disclosure | A message obtains tools, credentials, raw registry internals, or unrestricted model output. | The Metagenda-facing CLI exposes only bounded labels/status, remote turns have zero active tools, database rows contain no secrets, and responses are bounded text. |
| Denial of service | Unbounded payloads, process output, polling, stale agents, or terminal rows wedge the bridge or Pi. | Character/output limits, subprocess and message TTLs, one active turn per session, SQLite busy timeout/capacity, stale-agent deletion, terminal-row pruning, and a local kill switch bound work. |
| Elevation of privilege | Prompt injection turns chat into shell, approval, deployment, todo, or operator authority. | A communication-only prompt is backed by the mechanical empty-tool invariant. The protocol has no command/approval variant; consequential control requires a separate decision and typed protocol. |

## Security invariants

- Remote messages can produce assistant text only; all Pi tools are inactive for
  the entire remote turn.
- The exact prior active-tool set is restored once after success, failure, abort,
  or shutdown.
- Delivery requires an unexpired exact session and an atomic claim token.
- Duplicate requester/dedupe pairs do not create a second model turn during the
  message retention window.
- An outward owner relay reaches Telegram only for a claimed message whose
  requester is a live roster agent other than the dispatcher session, carries
  that requester's id, and is otherwise completed as a recorded refusal naming
  the reason rather than dropped or delivered anyway.
- Disabling the bridge prevents new enqueue/claim operations without changing
  ordinary local Pi behavior.
- Unknown protocol versions, malformed rows, unsafe characters, and invalid
  transitions fail closed without reflecting sensitive input in diagnostics.
- No Telegram token, owner credential, secret, approval, or tool argument is
  stored in bridge state or passed on a command line.

## Verification

Contract tests cover bounded prompts/output, malformed inputs, exact tool-set
restoration, owner-only filesystem modes, deduplicated enqueue, exact claim
tokens, expiry, disabled claims, terminal pruning, stale sessions, and the
machine-readable CLI boundary. Metagenda separately tests owner authentication,
bootstrap identity-only behavior, exact argv/stdin invocation, protocol decoding,
and duplicate Telegram updates before deployment.
