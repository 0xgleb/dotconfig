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

## Remaining boundaries

- `todo/state.ts` models branch-local tasks; `todo/backlog-adapter.ts` emits
  snapshots. The todo extension owns Pi branch persistence, events, UI and
  reminder timers. Its working-tree edits are outside the closures above.
- `classified-workflows/goal.ts` is session-goal logic, not an established
  project allocation API. Provider allowance policy is not project budgeting.
- Telegram parsing still includes personal CABA callback handling. Its generic
  decoding, authorization and relay helpers require a separate selected export;
  do not include the bot client, poller, credentials or live chat state.
- The SolidJS dashboard requires an observational adapter and reviewed asset
  integration. Exclude write/admission routes, worker mutations, job enqueueing
  and uncommitted UI/package integration.

Keep packages separate from workstation activation. Pin downstream consumption
to a landed receiving revision and verify its real exports before wiring it.
Live state migration, runtime switching and retirement require their separate
authorization and recovery gates.
