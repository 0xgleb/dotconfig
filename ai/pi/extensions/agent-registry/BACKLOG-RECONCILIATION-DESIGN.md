# Durable backlog reconciliation design

## Problem

Pi currently has several durable but independent work representations:

- authenticated owner turns and Piece of Pi messages;
- expiring bridge messages;
- durable registry requests;
- branch-local todos;
- tracker issues and pull requests;
- repository backlog documents.

A local todo projection can therefore report zero active work while executable work exists elsewhere. Repeated relays also become separate tasks, while requirements, authority, assignment, review, publication, and terminal evidence have no single lifecycle.

## Verified constraints

- Registry request bodies are untrusted routing data and grant no authority.
- Bridge messages expire and cannot be the canonical backlog.
- Branch todos are useful session projections but are not a complete repository inventory.
- Tracker and document collectors may be unavailable; absence of a collector result is not an empty backlog.
- Existing registry SQLite storage already provides serialized local durability, role leases, request lifecycle state, strict schemas, and bounded project views.
- The HUD must remain bounded and model-free. It consumes a cached typed projection; it never scans trackers or runs semantic deduplication during render.
- No model output may merge requirements, transfer authority, assign work, publish, or mark work terminal.

## Caller-first contract

```ts
const ingestion =
  yield *
  backlog.ingest({
    project,
    source: { kind: "registry-request", id: request.id },
    observedAt: now,
    priority: request.priority,
    requirements: [{ text: request.text }],
    authority: { kind: "routing-only" },
    dedupe: { kind: "exact-content" },
  })

const view = yield * backlog.view({ project, now })
// view.actionable > 0 OR view.unreconciled > 0 prevents an empty-work claim.

const assigned =
  yield *
  backlog.transition({
    itemId,
    expectedRevision,
    event: { kind: "assign", agentId, leaseId },
  })

const completed =
  yield *
  backlog.transition({
    itemId,
    expectedRevision,
    event: {
      kind: "complete",
      evidence: [{ kind: "registry-outcome", ref: requestId }],
    },
  })
```

## Domain shape

```ts
type BacklogSource =
  | { kind: "owner-message"; id: string }
  | { kind: "bridge-message"; id: string }
  | { kind: "registry-request"; id: string }
  | { kind: "branch-todo"; id: string }
  | { kind: "tracker-item"; id: string }
  | { kind: "backlog-document"; id: string }

type Authority =
  | { kind: "routing-only" }
  | { kind: "authenticated-owner"; ref: string }
  | { kind: "repository-policy"; ref: string }

type WorkState =
  | { kind: "unreconciled" }
  | { kind: "ready" }
  | { kind: "assigned"; agentId: string; leaseId: string }
  | {
      kind: "implementing"
      agentId: string
      leaseId: string
      implementationRef: string
    }
  | {
      kind: "in-review"
      agentId: string
      leaseId: string
      implementationRef: string
      reviewRef: string
    }
  | {
      kind: "publishing"
      agentId: string
      leaseId: string
      implementationRef: string
      reviewRef: string
      publicationRef: string
    }
  | { kind: "blocked"; reason: string }
  | {
      kind: "terminal"
      outcome: "completed" | "cancelled"
      evidence: readonly Evidence[]
    }
```

Every item has a monotonic revision, one project, one state, one or more immutable source records, and one or more immutable requirement records. Terminal completion is unrepresentable without bounded evidence. Assignment and active phases are unrepresentable without an exact runtime/lease pair.

Exact source identity is idempotent. Exact normalized-content repetition within one project may attach another provenance record to an existing non-terminal item. Near-duplicate semantic candidates remain `unreconciled` until a deterministic canonical identifier or explicit typed reconciliation links them. A model may suggest candidates, but its output is advisory data and cannot merge them.

## Design A: control-plane canonical backlog

The control-plane service owns backlog tables and exposes loopback HTTP ingestion, transition, and projection endpoints. Registry, Telegram, todo, and tracker adapters call those endpoints.

### Benefits

- One service can collect trackers and repository documents.
- Dashboard integration is direct.
- The Pi extension surface stays smaller.

### Costs and falsification

- Loopback outage would hide or block the canonical task state.
- Registry requests would be durably stored once in registry SQLite and again in control-plane SQLite, requiring distributed reconciliation.
- Session-local HUD updates would depend on HTTP freshness.
- This design is falsified by the existing requirement that quiet registry/todo operation survive dashboard/control-plane downtime.

## Design B: registry-owned backlog ledger with adapters

A dedicated backlog module and tables live beside registry requests in the same SQLite database. `SqliteRegistryStore` implements both `RegistryStore` and `BacklogStore`, but the interfaces remain separate. Request enqueue/claim/outcome transitions update request and backlog state in one transaction. Other sources enter through bounded typed events or a CLI adapter. The control plane and HUD consume projections; they do not own the lifecycle.

### Benefits

- Request ingestion and lifecycle linkage are atomic.
- One local serialized store remains usable when the dashboard is down.
- Immutable source/requirement/evidence rows preserve provenance without turning the request table into a pass-through abstraction.
- Project-scoped projection already matches registry ownership and routing.

### Costs and falsification

- Schema migration and operational snapshots become deeper.
- Tracker/document collectors need bounded adapters rather than writing SQLite directly.
- If most backlog operations later require remote multi-user transactions, the local registry store would become the wrong owner and the design must be revisited.

## Decision

Choose Design B. The stable policy is durable local work ownership and lifecycle; dashboard and transport are volatile projections. Keeping request and backlog transitions in one transaction removes a distributed consistency problem and preserves operation during control-plane outages.

The backlog module is not folded into `RegistryStore`: `BacklogStore` is a separate interface implemented by the same SQLite adapter. This keeps registry role/lease callers independent from backlog evolution while allowing atomic adapter methods inside the concrete store.

## Module map and dependency direction

```text
shared source adapters (Telegram / bridge / todo / tracker / docs)
                  |
                  v
agent-registry/backlog.ts          domain types, validation, reducer
                  |
                  v
agent-registry/sqlite-store.ts     atomic persistence and projection
                  |
        +---------+---------+
        |                   |
        v                   v
agent-registry/index.ts      shared/backlog-events.ts
 request adapter             cached projection event
                                |
                                v
                         todo presentation/HUD

control-plane dashboard ---> read-only typed backlog projection (later slice)
```

No adapter writes SQLite directly. No HUD or dashboard caller reduces lifecycle state.

## State transitions

- `unreconciled -> ready`: every requirement has a typed project and no unresolved dedupe candidate.
- `ready -> assigned`: exact live lease/runtime pair.
- `assigned -> implementing`: bounded implementation reference and execution acknowledgment.
- `implementing -> in-review`: immutable bounded review reference.
- `in-review -> publishing`: immutable bounded publication reference after the independent review gate where required.
- any non-terminal state -> `blocked`: bounded reason; requirements remain intact.
- active/blocked -> `terminal`: cancellation evidence, or completion evidence appropriate to the task.

A transition uses optimistic revision matching inside `BEGIN IMMEDIATE`. Stale callers receive a typed conflict and must reread; no last-writer-wins fallback. Agent-driven completion is legal only after implementation starts and always records both the registry outcome and implementation-summary references. Canonical tracker/document/todo closure uses a distinct source-reconciliation transition, so external lifecycle evidence cannot masquerade as an agent implementation claim. Exact duplicate requests may add terminal evidence to an already-terminal logical item, but cannot erase or overwrite prior evidence.

## Persistence

Additive strict tables:

- `backlog_items`: identity, project, priority, state, revision, timestamps.
- `backlog_sources`: immutable source kind/id, item ID, authority class/ref, observed time, content digest.
- `backlog_requirements`: immutable bounded text/digest linked to source and item.
- `backlog_evidence`: immutable phase/kind/ref/timestamp.
- `backlog_transitions`: append-only prior/new state, revision, actor, timestamp.

The operational projection reads only open items and counts terminal rows awaiting evidence acknowledgment. Historical rows remain durable but do not enter every heartbeat. The control plane reads the separate `BacklogStore` interface, enumerates bounded durable project identities, and emits only per-state/per-phase counts. It never returns source requirements, request bodies, authority records, or raw evidence references to the dashboard.

## Migration and rollback

1. Add tables without changing existing registry request semantics.
2. Shadow-ingest registry requests and compare counts; HUD still says external backlog unreconciled.
3. Surface registry-backed `actionable` and `unreconciled` counts in the HUD.
4. Add branch-todo ingestion and exact reconciliation.
5. Add bridge/owner adapters, then tracker/document collectors.
6. Make backlog assignment authoritative only after parity metrics show no dropped requirements or terminal mismatches.

Rollback disables adapters/projection while preserving additive tables. Existing requests and todos continue unchanged. No migration deletes or rewrites source state.

## Declared source collector design

Caller usage is model-free and session-scoped. After a trusted project starts,
the registry asks a collector for snapshots, reconciles each validated snapshot
transactionally, and updates the cached projection. If no declaration exists,
the collector returns no snapshot and leaves tracker and document coverage
unreconciled. A collection failure returns a typed diagnostic and likewise
leaves coverage unreconciled; it never emits an empty complete snapshot.

The caller-facing manifest is versioned and bounded:
`{ version: 1, document?: string, github?: { repository?: string } }`. It exists
only at `<project>/.pi/backlog-sources.json`. Document paths must be relative,
remain inside the canonical project root, avoid protected-path shapes, resolve
without symlinks, and remain within the existing 4 MiB declaration limit. A
GitHub repository may be omitted or must exactly match the canonical GitHub
origin. Collector output is limited to `CanonicalBacklogSnapshot`; filesystem,
Git, GitHub CLI, decoding, pagination, timeout, and cancellation failures remain
in a typed `BacklogCollectorError` channel.

Design C uses implicit conventions: collect the current GitHub origin and
conventional `BACKLOG.md` and `ROADMAP.md` files whenever they exist. It has no
setup cost, but file existence silently establishes source authority, multiple
documents make complete-coverage semantics ambiguous, and each session may
perform unwanted network work. It is falsified by the requirement that only
project-declared backlog documents enter the ledger.

Design D uses the explicit manifest above. The collector reads no project
document and makes no GitHub request until a trusted manifest declares that
source. One declared document defines the complete project backlog-document
scope; the existing exact `pi-backlog:complete` marker remains required before
coverage clears. The GitHub collector resolves one canonical origin, paginates
the issues endpoint without exposing credentials or remote URLs, rejects
capped, truncated, or malformed responses, and marks tracker coverage complete
only after every page validates. Session shutdown aborts outstanding work, and
a lifecycle epoch causes late results to be ignored before any registry or UI
call.

Choose Design D. It makes source authority explicit, distinguishes absence from
an empty backlog, gives complete coverage one unambiguous scope per source, and
avoids unsolicited network access. The cost is an opt-in manifest and one
declared document per project. Redesign only if two real projects need multiple
independently complete backlog documents; then add a manifest-level aggregate
snapshot rather than treating one document's complete marker as global.
Rollback disables the collector while retaining its additive ledger rows;
manual `agent_registry ingest_backlog` remains available.

## First vertical slice

- Implement domain validation/reduction plus additive SQLite tables.
- Shadow-ingest every registry request atomically.
- Exact duplicate request content within one project attaches provenance to one open item.
- Project projection exposes actionable, blocked, unreconciled, and total-open counts.
- Todo HUD accepts the cached projection and cannot render a zero-work implication when external open/unreconciled work exists.
- Existing request/todo APIs and lifecycle remain unchanged.

## Required red-first tests

1. Two identical registry requests create one open work item and two provenance records; no requirement is dropped.
2. Same text in different projects never deduplicates.
3. Routing-only provenance cannot become authenticated-owner authority after deduplication.
4. A semantically similar but non-identical request remains unreconciled rather than auto-merged.
5. Terminal completion without evidence is rejected.
6. A stale revision cannot overwrite a newer state.
7. Malformed/oversized/control-bearing text fails before persistence.
8. Duplicate floods remain bounded and do not increase actionable count.
9. Project projection with zero local todos and one external item reports external work, never `0 active` as a complete inventory.
10. A corrupt or unknown backlog row fails closed; it never becomes an empty projection.

## Falsification signals

Redesign if two independent adapters need direct store internals, if semantic merge exceptions multiply, if local SQLite prevents required multi-user concurrency, or if callers repeatedly need source-specific fields after ingestion. Those are evidence the canonical item is too shallow or owned by the wrong boundary.
