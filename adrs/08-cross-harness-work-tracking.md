# 08. Track all actionable work in a cross-harness canonical layer

- Status: Proposed
- Date: 2026-08-02
- Issue: None (owner-stated direction, personal orchestration architecture)

## Context

The owner works across multiple model harnesses (Claude Code, Cursor, Codex,
Pi) and switches between them constantly — by work type, or when a harness runs
out of usage credits. Pi setup work itself is frequently done from Claude Code
for exactly that reason.

Each harness has its own private context and memory mechanisms (Claude Code
personal memory, Cursor rules, Pi session state). Anything actionable recorded
only in one harness's private layer is invisible to whichever harness picks the
work up next. This has already caused direction to be lost: a Pi-facing
requirement was once recorded only in Claude Code's personal memory, where no
other harness could ever read it.

The existing durable layers are GitHub issues (or Linear, in Linear-tracked
projects), repository docs (specs, roadmaps, ADRs, `AGENTS.md` files), and the
local SQLite databases Pi owns (agent registry per ADR 02, durable job control
plane per ADR 07). ADR 07 also records that the persistence layer is expected
to eventually move to `~/code/dataclique/event-sorcery` once it has TypeScript
interop, and deliberately preserved an adapter seam instead of blocking on it.

## Decision

Establish one canonical tracking hierarchy for everything that needs acting on
— direction, constraints, backlog, follow-ups, requirements:

1. **Broad canonical tracker: issues and repo docs.** GitHub issues plus the
   repository's own docs (specs, roadmaps, ADRs, operating rules) are the
   canonical home for actionable work. Projects that use Linear track issues in
   Linear instead. Standing behavioral constraints belong in the repo docs that
   agents load (e.g. `ai/pi/AGENTS.md`); discrete work items belong in issues.
2. **Everything else: the local Pi database, with upward references.** Any
   actionable record that does not fit the issue/docs layer (operational tasks,
   scheduled duties, coordination state) must live in the local task-management
   / agent-registry database Pi uses. Every such record must reference the
   broader GitHub/Linear issue and the project spec/roadmap it serves, so local
   state is always traceable to canonical intent.
3. **Design persistence for a clean event-sorcery migration.** The owner plans
   to migrate the persistence layer fully to `~/code/dataclique/event-sorcery`
   once it has TypeScript interop. Until then, local stores keep the
   constraints that make that migration clean: typed bounded records, an
   append-only event trail alongside current-state rows, and storage access
   behind domain operations rather than leaked SQL (the seam ADR 07 already
   requires).
4. **Harness-native memories are projections, never sources of truth.** For
   harnesses with less flexibility over how context is supplied, the canonical
   layer is projected into their native memory systems (e.g. Claude Code
   memory files). Initially the projection is conceptual and manual — the
   working agent writes it by hand while working in that harness. Once the
   persistence layer is on event-sorcery, a Reactor automates these
   projections. A projection may summarize or specialize, but the canonical
   record it derives from must exist first.

## Alternatives Considered

### Keep using each harness's private memory for what that harness needs

- Pros: No coordination overhead; each harness's mechanism is ergonomic
  locally.
- Cons: Records are unreadable from every other harness; work is lost or
  duplicated at each switch; the owner switches harnesses constantly.
- Rejected because: Cross-harness continuity is the primary requirement, and
  private memories structurally cannot provide it.

### Force everything into GitHub/Linear issues

- Pros: One tracker, fully remote, visible to every harness and to humans.
- Cons: Operational records (scheduled duties, leases, coordination state,
  fine-grained task breakdowns) are too numerous and short-lived for a remote
  tracker; issue spam buries real work.
- Rejected because: The local database already exists for operational state
  (ADRs 02 and 07); references from local records to issues give traceability
  without the noise.

### Block tracking work until event-sorcery is ready

- Pros: Avoids designing a migration seam; one persistence architecture.
- Cons: TypeScript interop and the final contract are not available yet; the
  cross-harness loss problem exists today.
- Rejected because: ADR 07 already resolved this trade-off — typed local stores
  with an adapter seam now, event-sorcery later.

## Consequences

- Local Pi database records gain reference fields tying them to canonical
  issues and specs; schema work in the agent registry and control plane must
  include them.
- Working agents in any harness are responsible for writing actionable
  direction to the canonical layer first, and only then (optionally) projecting
  it into the harness's native memory. "Track this" from the owner always means
  the canonical layer.
- The eventual event-sorcery migration inherits clean inputs: typed records,
  append-only events, and explicit upward references become event streams and
  projections. The manual harness-memory projections become a Reactor's
  responsibility, removing the by-hand step.
- Until the migration, there are two local stores (agent registry, control
  plane) plus remote trackers; the reference discipline is what keeps them
  coherent.
