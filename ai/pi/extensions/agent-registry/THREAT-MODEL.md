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

| Threat                 | Concrete abuse case                                                                                                                                          | Control and first failing test                                                                                                                                                                                                                                                                                  |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Spoofing               | A stale session claims or completes work under a replaced lease                                                                                              | Every mutation binds owner and lease IDs; stale-lease request completion fails                                                                                                                                                                                                                                  |
| Tampering              | Two processes race a role claim or a writer dies mid-transition                                                                                              | SQLite `BEGIN IMMEDIATE` transaction; concurrent-claim and killed-writer tests                                                                                                                                                                                                                                  |
| Repudiation            | Nobody can tell whether a request was merely persisted, visibly received, or accepted as work                                                                | Durable `recipient_received_at` plus recipient lease/agent identity distinguishes queued from received; explicit claim distinguishes acknowledged                                                                                                                                                               |
| Information disclosure | An automatic receipt injects an untrusted request body into the recipient model context                                                                      | Receipt notices include only bounded request ID and validated target metadata; the body requires an explicit classified detail read                                                                                                                                                                             |
| Denial of service      | A sender floods a live agent, labels prose “urgent” to force one model turn per request, or accumulated terminal history exhausts the Pi heap during polling | Priority must be explicit typed data; normal receipt stays passive; urgent receipt coalesces at most 64 requests into one bounded idle turn and yields to human/reload/pending work; acknowledged terminal rows remain durable but are excluded by the operational snapshot SQL before SQLite materializes them |
| Elevation of privilege | Claiming `production-operator` grants shell, wallet, signer, SSH, or database rights                                                                         | Registry never changes active tools; policy revision is descriptive and tool-level allow/deny tests remain authoritative                                                                                                                                                                                        |

## Security invariants

- Exactly one unexpired lease may exist per canonical project-role key.
- A lease is valid only for its owner, lease ID, policy digest, and TTL.
- Model identity never affects authority.
- Unowned roles self-claim in the current session; the registry never launches a
  process automatically.
- Operational leases have no automatic completed state.
- Durable queueing, recipient receipt, urgent wake, and explicit acknowledgment
  are separate facts. A successful enqueue never proves delivery or acceptance.
- Operational snapshots include open requests and terminal results awaiting
  requester acknowledgment. Acknowledged terminal history remains durable in
  SQLite without re-entering each five-second fleet poll.
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

## Backlog reconciliation boundary

The durable backlog adds six untrusted ingestion boundaries: authenticated
owner messages, bridge messages, registry request bodies, branch todos,
tracker records, and repository backlog documents. Transport authentication is
recorded as provenance; it is never inferred from text. Forwarded or
agent-authored text stays untrusted even when it repeats an authenticated owner
instruction.

The protected assets are the complete requirement set, authority provenance,
exclusive assignment, review/publication gates, terminal evidence, and the
truthfulness of the actionable/unreconciled projection.

| Threat                 | Concrete abuse case                                                                                           | Required first failing test and control                                                                                                                                                                         |
| ---------------------- | ------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Spoofing               | An agent repeats an owner request and inherits owner authority                                                | Deduplication preserves each source's authority class; routing-only input cannot upgrade an item                                                                                                                |
| Tampering              | A duplicate merge drops a constraint or overwrites a newer state                                              | Requirements and provenance are immutable child rows; optimistic revisions reject stale transitions                                                                                                             |
| Repudiation            | Work is called complete without implementation, review, or publication evidence                               | Agent completion requires an implementation phase, bounded immutable phase references, terminal registry outcome + summary references, and append-only transitions; source reconciliation uses a distinct event |
| Information disclosure | A secret-bearing request body appears in the HUD, logs, or semantic dedupe prompt                             | Ingestion rejects credential-shaped/control-bearing text; projections contain counts and bounded titles only                                                                                                    |
| Denial of service      | Repeated relays create thousands of actionable copies or force semantic model calls during render             | Exact source/content idempotency, bounded tables, pending reconciliation counts, and model-free cached projections                                                                                              |
| Elevation of privilege | Merging an owner request with a routed implementation request authorizes assignment, mutation, or publication | Authority is attached to provenance and checked independently at each action boundary; model suggestions cannot transition state                                                                                |

The `agent_registry ingest_backlog` action is a model-facing tool boundary
restricted to the current project. It accepts only already-collected GitHub
issue or pull-request records or explicit `pi-backlog` declarations supplied
from a repository document. The tool performs no network or file access.
TypeBox validation and the source adapter reject malformed, oversized,
control-bearing, cross-project, mixed-source, or ambiguous input before
persistence. Ingested tracker and document text remains routing-only provenance
and cannot grant assignment, mutation, review, publication, or terminal
authority. A successful tool result is returned only after the registry SQLite
transaction completes and the bounded projection is updated. Complete coverage
is recorded only when the caller explicitly supplies complete tracker coverage
or the document contains the exact completeness marker; collector absence or
failure leaves the source unreconciled.

The model-free collector reads no project document and makes no GitHub request
until a trusted project manifest declares that source at
`<project>/.pi/backlog-sources.json`. Declared document paths must stay inside
the canonical project, contain no symlink or protected-path component, and fit
the existing bounds. Missing, malformed, cancelled, or failed collection never
emits an empty complete snapshot. Session shutdown aborts outstanding reads;
lifecycle-epoch checks reject late results before registry or UI access.

The declared GitHub collector introduces two external boundaries: the
repository's local origin URL and authenticated, read-only responses from the
GitHub API. Protected assets include the exact repository scope; complete issue
and pull-request requirements and lifecycle; truthful coverage; bounded process
and runtime resources; and the confidentiality of GitHub authentication.
Origin parsing accepts only canonical `github.com` owner/name forms, and the
manifest repository must match that origin; unsupported hosts, credentials in
URLs, ambiguity, or mismatches fail before any API call. GitHub pages are
untrusted: unknown shapes, controls, oversized fields, duplicate records,
pagination overflow, timeouts, cancellation, nonzero exit status, or truncated
output fail the entire collection and leave tracker coverage unreconciled.
Complete coverage is emitted only after both issues and pull requests reach
validated terminal pages. The subprocess runner uses fixed `git` and `gh`
executables and arguments, a bounded allowlisted environment without token
variables, output, page, and item caps, timeouts, and process-group
cancellation. Stderr and raw remote responses never enter the UI, model context,
or durable rows. Collected text serves only as routing provenance and cannot
authorize assignment, mutation, review, publication, or terminal transitions.

Backlog phase transitions are lease-bound and source-local. Claiming a registry request records assignment; `start_request`, `review_request`, and `publish_request` record immutable implementation, review, and publication references in order. These actions record lifecycle only and grant no mutation, review, publication, or remote authority. Agent-driven completion cannot skip implementation and records both the registry outcome and persisted implementation-summary reference. Existing callers that complete immediately after a claim are migrated atomically through a typed implementation-start transition backed by the successful completion summary. Canonical tracker/document/todo closure uses the separate source-reconciliation transition rather than claiming agent implementation. Duplicate source completions append evidence without overwriting prior terminal evidence.

The loopback control-plane backlog projection is read-only and count-only. It enumerates bounded canonical project IDs from the backlog store, validates every persisted row through the domain decoder, and returns per-project lifecycle/evidence counts. It never exposes source requirements, request text, authority records, evidence references, or mutation controls. Any store or decode failure returns a bounded 500 response instead of an empty projection.

Backlog ingestion must fail closed on malformed rows or unknown schema/state.
An unavailable tracker/document collector produces an explicit unreconciled or
stale-source count; it never becomes an empty backlog. A local todo projection
must not claim global completeness. Model output may suggest reconciliation
candidates, but cannot merge sources, discard requirements, transfer authority,
assign work, publish, or mark an item terminal.

## Dependency and future-adapter posture

No new dependency is introduced: Effect is already installed for Pi extensions.
The SQLite store implements an Effect `RegistryStore` service using Node 24's
built-in `node:sqlite`, so no package is added. Event-sorcery 0.5.0 TypeScript
bindings may later provide another adapter, but unreleased APIs are not
assumed and no local event-sorcery imitation is built.
