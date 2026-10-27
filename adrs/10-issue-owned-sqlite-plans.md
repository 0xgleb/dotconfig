# 10. Issue-owned execution plans in SQLite

- Status: Proposed
- Date: 2026-10-26
- Issue: Tracking issue pending creation

## Context

The todo extension restores writable state from a Pi session journal. Manager
reads and mutations use a selected worker's live task endpoint. A restored
selection can name an old worker session even while a different worker is
running in the same checkout. Session identity and process availability
therefore limit access to an execution plan that should outlive both.

The owner selected a different ownership model: GitHub issues describe
deliverables, GitHub Projects own cross-repository scheduling within the
selected personal and organization scopes, and SQLite owns the execution steps
inside issues. Worker sessions execute work but do not own its identity or plan.

## Decision

Address plans by repository-qualified GitHub issue identity. Store execution
steps, blockers, history and legacy migration links in relational SQLite tables.
These tables share the registry's physical database, with feature-owned schema
versioning that preserves registry tables and its `user_version` ownership. Rank
and remaining-delivery Fibonacci effort belong to the applicable GitHub Project,
not independently writable scheduling fields on each step. The owner selected a
new private personal Project and the existing
[Dataclique Project 12](https://github.com/orgs/dataclique/projects/12/views/4).

Every plan operation names its issue scope explicitly. Validate the entire
multi-step/multi-issue mutation and save it in one local transaction. Callers do
not supply expected revisions: tools load and validate current state inside the
transaction and return the actual persisted target and revision. Transfers
preserve step identity. The replacement tool is named `task`, with lifecycle
`todo | doing | done | cancelled`. Cancellation requires the owner or an
authorized manager. Blockers are factual data, not scheduling states; issue
holds and deferral remain manager-controlled. There is no `in_review` state.

GitHub operations cannot participate in a SQLite transaction. Results must
distinguish saved effects, confirmed failures and unknown completion, retaining
the reconciliation needed after partial success. A split issue remains
unscheduled until its issues, plan and dependencies are consistent.

Use one authoritative assignment selector across issue-next, HUD, continuation,
manager views and safe-boundary notifications. Scheduling never changes holds,
renews an allowance or starts an idle or paused worker.

Migration is a single authority cutover. Import legacy state with an explicit
mapping from its original session/branch/task identity; preserve private history
locally rather than publishing it as issue content. Switch all plan readers and
writers together and disable independent session-journal writes. Retain legacy
history read-only. A failed cutover must not reopen a second writable backlog.

Structured VCS tools are subsequent deliveries and do not gate this cutover.

## Alternatives Considered

### Extract todos from session journals on every offline read

- Pros: Can recover an existing backlog without waiting for a worker endpoint.
- Cons: Keeps plan identity coupled to session ancestry, retains multiple
  restoration rules and does not make offline edits authoritative.
- Rejected because: The owner requires issue-owned SQLite plans, not another
  session-local control path.

### Publish worker snapshots to a manager cache

- Pros: Removes endpoint dependence for the last published observation.
- Cons: Snapshots may omit requirements or lag writes; making them editable
  creates a second writable backlog and reconciliation protocol.
- Rejected because: A cache is not the execution plan's authority.

### Keep execution checklists entirely in GitHub issue bodies

- Pros: Remote issue access needs no local plan database.
- Cons: Issue-body updates do not provide stable transferable step identities or
  atomic cross-issue plan changes; private execution history risks becoming
  public issue content.
- Rejected because: The selected boundary is GitHub deliverables and scheduling,
  with transactional execution plans in SQLite.

## Interface bounds

The initial issue-scope decoder accepts up to 100 distinct issues per call. This
is an implementation resource bound on validation work, not a scheduling rule or
a limit on the total backlog. Larger reads must paginate; mutations exceeding
the limit are rejected before any write rather than split into partial batches.

## Consequences

After cutover, plan access will not depend on a session selection or a worker
process. Local atomicity is explicit; remote partial completion remains a
reconciliation boundary rather than an exactly-once promise.

Table namespaces are not an access-control boundary: a process with whole-file
access can read both registry and task data. Whole-file copies inherit the
privacy requirements of both. Existing tool and role authority still bounds
reads, reports and exports; co-location does not authorize publishing private
history or adding it to registry reports.

The replacement must migrate every mutation path, including UI actions,
reminders, restoration and compaction hooks, as well as manager and continuation
readers. Replacing only the tool handler would leave competing authorities.

Issues without an effort estimate are ineligible and belong in refinement for a
manager or human to specify and estimate. There is no invented effort fallback.

The shared file can be renamed to `pi.sqlite` during the coordinated migration;
adding the feature tables does not itself rename or migrate the live file. The
owner must stop workers before cutover. Unavailable TypeScript bindings do not
make event-sorcery a prerequisite. Blockers must describe genuine inability to
proceed; lower scheduling priority is not a technical blocker. Existing proposed
control-plane ADRs do not make a new daemon, registry-role system or messaging
protocol a prerequisite.
