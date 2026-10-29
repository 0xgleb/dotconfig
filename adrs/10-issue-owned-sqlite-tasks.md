# 10. Issue-owned tasks in SQLite

- Status: Proposed
- Date: 2026-10-26
- Issue: Tracking issue pending creation

## Context

The todo extension restores writable state from a Pi session journal. Manager
reads and mutations use a selected worker's live task endpoint. Session ancestry
and process availability therefore constrain access to work that should outlive
both.

GitHub issues describe deliverables. GitHub Projects provide cross-repository
scheduling, while local tasks describe the execution steps within an issue.
Worker sessions execute those tasks but do not own their identity.

## Decision

Tasks belong directly to repository-qualified GitHub issues. Store their stable
identities, dependencies, factual blockers, immutable history and legacy
migration links in SQLite. There is no separately addressable plan or container.
SQL row identifiers are private storage bookkeeping, not task API inputs or
outputs.

Share the registry's physical database, with feature-owned schema versioning
that preserves registry tables and its `user_version` ownership. Address task
reads and writes by qualified issue identity and return issue revisions. Every
mutation names its complete issue scope. Validate the entire batch and save it
in one local transaction, loading current state under the write lock rather than
accepting caller revision tokens. A retry with the same authenticated request
identity returns the original durable receipt, not a new observation of current
state.

Task transfers preserve identity, content, lifecycle, blockers and dependency
edges. History records the prior issue from the executor's observed state.
Advance each affected issue's revision once per batch, including intermediate
owners; no-op operations do not advance revisions. References by existing task
ID must name its current owner. Batch-local creation aliases retain their
original issue qualification after a transfer.

The replacement tool is named `task`. Its mutations are add, edit, status, block
and transfer; lifecycle is `todo | doing | done | cancelled`. Trusted host
context supplies cancellation and reopening authority, never model-authored
fields. Blockers are factual data, not scheduling states. Holds and deferral
belong to issue scheduling. There is no `in_review` task state.

Use the existing personal Project and existing organization Project. Bind their
verified numeric **Priority** fields with their actual scopes: the personal
field is project-local, while the organization field is an issue field surfaced
in the Project. Do not create a replacement Project or a Rank field.
Remaining-delivery Fibonacci effort belongs to issue scheduling, not individual
tasks; its binding must identify the actual field and scope rather than treating
an Estimate field as an Effort field. Issues without an estimate remain in
refinement and are ineligible for assignment.

Owner-approved workers may perform their authorized issue creation, updates and
splits, and apply owner-confirmed ordering, without a manager role, a live
manager or worker-manager communication. Approval remains scoped; registry
ownership does not grant remote mutation authority or give read-only managers
coding capability.

GitHub operations cannot participate in a SQLite transaction. Distinguish saved
effects, confirmed failures and unknown completion, retaining the evidence
needed to reconcile partial success. A split issue remains unscheduled until its
issue, tasks and dependencies are consistent.

Use one assignment selector across issue-next, HUD, continuation, manager views
and safe-boundary notifications. Scheduling never changes holds, renews an
allowance or starts an idle or paused worker.

Migration is a single authority cutover. Import legacy state through an explicit
mapping from original session, branch and task identities. Preserve private
history locally rather than publishing it as issue content. Switch every reader
and writer together, disable independent session-journal writes and retain
legacy history read-only. A failed cutover must not reopen a second writable
backlog.

## Alternatives Considered

### Extract tasks from session journals on every offline read

- Pros: Recovers existing work without waiting for a worker endpoint.
- Cons: Keeps task ownership coupled to session ancestry and does not make
  offline edits authoritative.
- Rejected because: Issue-owned task storage must replace session-owned writable
  state, not add another restoration path.

### Publish worker snapshots to a manager cache

- Pros: Removes endpoint dependence for the last published observation.
- Cons: Snapshots can omit requirements or lag writes; editable snapshots create
  another writable backlog and reconciliation protocol.
- Rejected because: A cache cannot be the authority for issue-owned tasks.

### Keep execution checklists entirely in GitHub issue bodies

- Pros: Remote issue access needs no local task database.
- Cons: Issue-body updates do not provide stable transferable task identities or
  atomic cross-issue task changes; private history can become public content.
- Rejected because: GitHub owns deliverables and scheduling, while SQLite owns
  transactional execution tasks and private history.

## Consequences

After cutover, task access will not depend on session selection or worker
availability. Local atomicity is explicit; remote partial completion remains a
reconciliation boundary rather than an exactly-once promise.

Table namespaces are not an access-control boundary. A process with whole-file
access can read registry and task data, and whole-file copies inherit both
privacy requirements. Co-location does not authorize publishing private history
or adding it to registry reports.

Migration must cover tool handlers, UI actions, reminders, restoration,
compaction hooks, manager readers and continuation readers. Schema creation
alone does not rename or migrate the live database. A separate readiness
notification and the owner stopping workers are prerequisites for live import
and cutover.

The issue-scope decoder accepts at most 100 distinct issues per call as a
resource bound, not a scheduling limit. Larger reads paginate; oversized
mutations fail before writing rather than splitting into partial batches.

Structured VCS tools, a new daemon, registry-role redesign and messaging changes
are not prerequisites for this cutover.
