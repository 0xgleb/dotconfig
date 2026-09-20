# Metagenda source exports

These are candidate source closures for
[Metagenda's migration baseline](https://github.com/dataclique/metagenda/issues/3),
not a completed import, approved source landing, or live cutover. The source
modules below are present at
[`55fe63d892778e09e205a315f7ef5ec2c93290f2`](https://github.com/0xgleb/dotconfig/commit/55fe63d892778e09e205a315f7ef5ec2c93290f2).
Their selected source revision must pass the source review, checks and merge
gate before receiving import. Preserve the root `LICENSE` with every extraction.

## Durable bridge core

Preserve these paths relative to `ai/pi/extensions/`:

- `remote-control/bridge-contract.ts`
- `remote-control/sqlite-store.ts`

Runtime dependencies are Effect and Node built-ins. The contract has no Pi SDK,
chat registry, Telegram client or personal-feature dependency. Existing host
callers continue importing `remote-control/protocol.ts`, which re-exports the
same runtime values and types; that host module is not part of this closure.

`makeRemoteBridgeStore(databasePath)` accepts the database **file** path. The
receiving composition owns its location and operation time inputs. Preserve
protocol version 6, additive migrations, queued/claimed/terminal states, claim
tokens, dedupe identities, TTLs, bounded input failures, question bindings and
conversation-delivery markers. Each operation owns its SQLite connection; there
is no public `close()` method.

## Canonical backlog and registry core

Preserve these paths relative to `ai/pi/extensions/`:

- `agent-registry/backlog.ts`
- `agent-registry/registry.ts`
- `agent-registry/runtime-identity.ts`
- `agent-registry/usage.ts`
- `agent-registry/sqlite-store.ts`
- `shared/backlog-events.ts`
- `shared/canonical-backlog.ts`

Runtime dependencies are Effect and Node built-ins. The existing backlog model
already represents source provenance, requirements, priority, assignment,
lease fencing, lifecycle transitions and implementation/review/publication
references. Do not replace it with a second planning ledger.

`makeSqliteRegistryStore(root)` accepts a database **directory** and uses
`registry.sqlite` beneath it. It exposes `close()` for its connection lifetime.
`reconcileCanonicalBacklog` and `reconcileBranchTodos` are the existing
persistence/reconciliation boundaries. `BacklogStore<RegistryError>` is the
existing read-only projection interface; it does not expose lease mutation.

Tracker/document imports retain `routing-only` provenance. A canonical record,
role lease, queue row or lifecycle reference is not authorization to execute
work. Preserve atomic rollback, source identities and revision checks. The
canonical decoder retains explicit partial/complete coverage metadata; this is
not evidence of completeness-driven reconciliation or removal of absent items.
No registry data or active leases accompany code.

## Verification

Run the isolated JavaScript-consumer regressions with Node:

```console
node --test ai/pi/extensions/remote-control/portable-store.test.ts ai/pi/extensions/agent-registry/portable-backlog.test.ts
```

They emit only the declared source files into isolated JavaScript fixtures,
provide Effect without Pi SDK packages, and use synthetic databases. Bridge
coverage includes runtime re-export identity, persistence, dedupe, claim-token
rejection, completion, malformed input and disabling. Backlog coverage includes
canonical decoding, routing-only provenance, repeated reconciliation, rollback
of later invalid reconciliation input and reopening persisted state.

These checks supplement the existing protocol/store/backlog suites; they do not
replace coverage of migrations, concurrency, permissions, images or questions.
A receiving package must also emit JavaScript and declarations with its real
compiler, then typecheck a compiled-only consumer with strict library checking
and without source files or Pi SDK mappings. Runtime type erasure alone is not
that static-consumer check. Node 24.19.0 is the locally exercised runtime; no Bun
runtime or cross-platform execution is implied.

## Full extension-runtime transfer

The small cores above are preparation, **not migration completion**. The shared
extension implementations must move to Metagenda and dotconfig must consume the
landed package. Keeping the runtime here while exporting only domain helpers
is insufficient.

The next published source candidate is
[`3b3dc588b9bf195bd3a5e818d6e069b3356c0c70`](https://github.com/0xgleb/dotconfig/commit/3b3dc588b9bf195bd3a5e818d6e069b3356c0c70),
not an approved source-master baseline. Preserve unrelated feature-branch and
working-tree changes; do not merge the whole branch or export dirty files.

Runtime inventory, relative to `ai/pi/extensions/`:

- `activity-status`, `agent-registry`, `agent-workspace`, `auto-reload`
- `classified-workflows`, `compact-footer`, `compact-read`
- `disk-pressure`, `image-summary`, `input-ergonomics`, `lsp`
- `nushell-default`, `questions`, `release-cadence`, `request-observability`
- `safe-compaction`, `usage-governor`, `write-result-inspector`
- Supporting infrastructure: `shared` and `control-plane`.

This inventory is **not yet a verified self-contained transfer allowlist**:

- Classifier `index.ts` imports bridge `paths.ts`, `protocol.ts` and
  `sqlite-store.ts`; the protocol also needs `chat-registry.ts` and
  `bridge-contract.ts`. Preserve this closure, without personal Telegram clients.
- Registry `index.ts` imports `todo/state.ts`, an upstream-origin boundary.
  Do not silently label that dependency locally owned.
- Classifier `core.ts` and `loop.ts` still contain personal policy exceptions;
  retain their behavior through the local policy boundary during relocation.
- Control-plane source/UI has unfinished working-tree changes. The immutable
  revision does not include or approve that WIP.
- `btw` is loaded locally but its ownership audit remains incomplete. Its
  introducing commit is `ea811877c608f286f811e3c9416d2f9eb207e3e8` (merged PR 55);
  repository introduction alone does not prove absence of upstream ancestry.

The extracted `classified-workflows/workflow-engine.ts` needs only Effect,
`node:vm` and `shared/memory-capacity.ts`; legacy `core.ts` exports remain intact.
119 focused tests, two portable regressions, strict TypeScript 5.9.3 emission
and a compiled-only consumer check passed. Static checks used installed Node 22
declarations, not receiving Node 26 declarations. Independent review confirmed
unchanged moved bodies/contracts and policy. These are **engine-only** gates,
not verification of the full runtime inventory.

### Keep separate

Personal browser, voice, workstation configuration and Telegram clients/pollers
remain local. Never transfer credentials or live state. `local-models` belongs
to local host integration; `link-safety` is not an active manifest entry.
Dependency directories and Home Manager backups are not source exports.

The declared upstream origins are:

- `todo`: `diegopetrucci/pi-extensions@966ac95f8d717be6f763c62c88f4beb92b6554d3`.
- `pi-vim`: `burneikis/pi-vim@8b99eccdcc4c6e472a52f2f334cac0284a597258`.

See their `UPSTREAM.md` notices. Consume upstream implementations as pinned
packages, preserve local behavior, and obtain separate authorization before
maintaining a fork. Do not copy either into Metagenda as first-party source.

Metagenda owns destination assembly/integration; dotconfig owns extraction and
compatible consumption. Completion requires approved source, a checked/reviewed
landed receiving package, verified consumer exports, and then removal of the
duplicate implementation. Do not delete currently referenced source before its
replacement is ready. Activation and state migration remain separately gated.

## Remaining boundaries

- `todo/state.ts` models branch-local tasks; `todo/backlog-adapter.ts` emits
  snapshots. The todo extension owns Pi branch persistence, events, UI and
  reminder timers. Its working-tree edits are outside the closures above.
- `classified-workflows/goal.ts` is session-goal logic, not an established
  project allocation API. Provider allowance policy is not project budgeting.
- Telegram parsing still includes personal CABA callback handling. Its generic
  decoding, authorization and relay helpers require a separate selected export;
  do not include the bot client, poller, credentials or live chat state.
- Exclude uncommitted dashboard/package integration from the immutable transfer.
  Moving existing control-plane code does not authorize invoking its write or
  admission routes, workers or job enqueueing. New dashboard designs and access
  policies are separate work, not prerequisites for relocating existing code.

Keep packages separate from workstation activation. Pin downstream consumption
to a landed receiving revision and verify its real exports before wiring it.
Live state migration, runtime switching and retirement require their separate
authorization and recovery gates.
