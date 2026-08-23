# Pi agent registry threat model

The registry coordinates local responsibility. It is not an authorization layer,
a process sandbox, or a source of production credentials.

## Trust boundaries

1. **Model -> `agent_registry` tool:** action, project, role, explicit request
   priority, request text, and result summaries are untrusted until parsed into
   bounded domain types. Priority is a closed `normal | urgent` value; request
   text never infers urgency. The
   destructive administrative clear additionally requires an explicit preserved
   project and exact confirmation text, and remains subject to the semantic tool
   classifier.
2. **Process -> shared SQLite database:** every row may be stale, malformed,
   maliciously edited, or concurrently targeted by another Pi process.
3. **Wall clock and process liveness -> lease logic:** clocks can move and
   processes can die between heartbeat and mutation.
4. **Registry role -> project tools:** role names and advertised capabilities
   are descriptive data and must never add tools or authorize an action.
5. **Registry -> Pi UI/model context:** paths, diagnostics, request text, and
   owner metadata must be bounded and must not disclose secrets. Automatic
   receipt notices contain only validated request metadata, never the request
   body; bodies enter model context only through a classified `agent_registry`
   result. Normal receipt remains passive. An explicitly urgent coalesced wake
   may contain only bounded request metadata and handling procedure, never bodies.
6. **Live role lease -> delivery receipt and wake:** only the current active
   lease for the exact project-role pair may receive a notice. Normal requests
   remain passive; an explicitly urgent request may wake exactly one bounded idle
   turn for the delivered batch. Receipt and wake are not work claims or authorization
   grants; explicit `claim_request` remains the first work acknowledgment.
7. **Pi -> Zellij (future explicit spawning):** tab/pane IDs and focus state are
   untrusted external responses; background focus restoration must be verified.
8. **Storage adapter boundary:** the SQLite adapter is first; a future
   event-sorcery TypeScript adapter must satisfy the identical contract without
   changing tool semantics.

## Assets

- exclusive ownership of each `{project, role}` pair;
- integrity and durability of delegated request lifecycle state;
- continuity of the explicitly preserved project during administrative cleanup;
- separation between responsibility routing and operational authority;
- the user's active Zellij tab, pane, and prompt draft;
- project paths and bounded safe diagnostics;
- denial of all credential, wallet, signer, unrestricted database, and raw SSH
  access not independently exposed by project-specific tools.

## STRIDE controls

| Threat | Concrete abuse case | Control and first failing test |
| --- | --- | --- |
| Spoofing | A stale session claims or completes work under a replaced lease | Every mutation binds owner and lease IDs; stale-lease request completion fails |
| Tampering | Two processes race a role claim or a writer dies mid-transition | SQLite `BEGIN IMMEDIATE` transaction; concurrent-claim and killed-writer tests |
| Repudiation | Nobody can tell whether a request was merely persisted, visibly received, or accepted as work | Durable `recipient_received_at` plus recipient lease/agent identity distinguishes queued from received; explicit claim distinguishes acknowledged |
| Information disclosure | An automatic receipt injects an untrusted request body into the recipient model context | Receipt notices include only bounded request ID and validated target metadata; the body requires an explicit classified detail read |
| Denial of service | A sender floods a live agent or labels prose “urgent” to force one model turn per request | Priority must be explicit typed data; normal receipt stays passive; urgent receipt coalesces at most 64 requests into one bounded idle turn and yields to human/reload/pending work |
| Elevation of privilege | Claiming `production-operator` grants shell, wallet, signer, SSH, or database rights | Registry never changes active tools; policy revision is descriptive and tool-level allow/deny tests remain authoritative |

## Security invariants

- Exactly one unexpired lease may exist per canonical project-role key.
- A lease is valid only for its owner, lease ID, policy digest, and TTL.
- Model identity never affects authority.
- Unowned roles self-claim in the current session; the registry never launches a
  process automatically.
- Operational leases have no automatic completed state.
- Durable queueing, recipient receipt, urgent wake, and explicit acknowledgment
  are separate facts. A successful enqueue never proves delivery or acceptance.
- Receipt requires the current live matching lease, is replaceable by a later
  live lease while work remains queued, and never claims work.
- Normal receipt never triggers a turn. Only explicit typed `urgent` priority may
  wake one bounded idle turn for a coalesced delivered batch; it contains no
  request body and yields to human input, pending messages, continuation pauses,
  and reloads.
- Manual interruption pauses work without silently releasing ownership.
- Unknown schema versions and malformed rows fail closed. Corrupt state is never
  replaced with an empty registry, because that would erase ownership and permit
  split-brain.
- Every string persisted from model input is length-bounded, control-character
  free, and rejects credential-shaped paths. Role names use a closed syntax.
- The state root is fixed by the extension from XDG/home state directories; tool
  input cannot choose an arbitrary filesystem path.
- No registry record contains credentials, secret values, wallet data, financial
  amounts, raw subprocess output, or unrestricted remote connection details.
- Unknown storage/process errors become bounded typed diagnostics; raw SQLite,
  filesystem, row, and model-supplied error text never reaches UI or model output.

## Observability questions

- **Who owns a role and is it live?** One typed registry snapshot/widget.
- **Where is a request stuck?** One durable request lifecycle record.
- **Why is a lease unusable?** One typed lease status/reason.
- **Was background focus restored?** One typed launch outcome when spawning is
  implemented; no prose-only success claim.

## Dependency and future-adapter posture

No new dependency is introduced: Effect is already installed for Pi extensions.
The SQLite store implements an Effect `RegistryStore` service using Node 24's
built-in `node:sqlite`, so no package is added. Event-sorcery 0.5.0 TypeScript
bindings may later provide another adapter, but unreleased APIs are not
assumed and no local event-sorcery imitation is built.
