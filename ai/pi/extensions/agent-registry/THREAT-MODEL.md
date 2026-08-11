# Pi agent registry threat model

The registry coordinates local responsibility. It is not an authorization layer,
a process sandbox, or a source of production credentials.

## Trust boundaries

1. **Model -> `agent_registry` tool:** action, project, role, request text, and
   result summaries are untrusted until parsed into bounded domain types.
2. **Process -> shared SQLite database:** every row may be stale, malformed,
   maliciously edited, or concurrently targeted by another Pi process.
3. **Wall clock and process liveness -> lease logic:** clocks can move and
   processes can die between heartbeat and mutation.
4. **Registry role -> project tools:** role names and advertised capabilities
   are descriptive data and must never add tools or authorize an action.
5. **Registry -> Pi UI/model context:** paths, diagnostics, request text, and
   owner metadata must be bounded and must not disclose secrets. Automatic
   follow-ups contain only validated request metadata, never the request body;
   bodies enter model context only through a classified `agent_registry` result.
6. **Pi -> Zellij (future explicit spawning):** tab/pane IDs and focus state are
   untrusted external responses; background focus restoration must be verified.
7. **Storage adapter boundary:** the SQLite adapter is first; a future
   event-sorcery TypeScript adapter must satisfy the identical contract without
   changing tool semantics.

## Assets

- exclusive ownership of each `{project, role}` pair;
- integrity and durability of delegated request lifecycle state;
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
| Repudiation | Nobody can tell why work or ownership stopped | Typed lease/request states and bounded reasons are the durable source shown by `/agents` |
| Information disclosure | Request text, diagnostics, or paths expose secrets | Strict length/path decoding; no file contents, environment, raw command output, or credential-shaped paths in state/UI |
| Denial of service | A crashed writer leaves the registry permanently locked or inbox grows without bound | Bounded lock retry/stale recovery, bounded record counts and text, typed `busy`/`capacity` errors |
| Elevation of privilege | Claiming `production-operator` grants shell, wallet, signer, SSH, or database rights | Registry never changes active tools; policy revision is descriptive and tool-level allow/deny tests remain authoritative |

## Security invariants

- Exactly one unexpired lease may exist per canonical project-role key.
- A routed request is closed only by the agent it was assigned to when it was
  routed, or by the session holding its project role lease. The assignment is a
  bridge agent id, compared against the sender of a bridge message when the row
  is closed and against the reading session's own id when claimability is
  decided; Pi sessions register on the bridge under their registry session ids,
  so an assignment can name a session that also holds a lease, and it is never
  matched against any other session's id. A lane that merely relays an outcome
  closes nothing on its own identity
  and never claims a lease to record one. The sender id is self-asserted: the
  bridge relays the requester id its local caller declared, so this fence is
  scoped to the local machine trust boundary and bounds honest lanes, not a
  process that can already run the bridge CLI.
- A routed request is claimed by nothing but the receiver it names. The session
  holding the role claims an assigned row only when the assignment names that
  same session, which is the case where claiming is the delivery rather than a
  second one; every other assigned row is left queued for the agent it names, so
  one instruction is never delivered to two executors.
- A lease is valid only for its owner, lease ID, policy digest, and TTL.
- Model identity never affects authority.
- An unowned role is taken by an explicit claim, never as a side effect of
  delegating a request; the registry never launches a process automatically.
- Operational leases have no automatic completed state.
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
