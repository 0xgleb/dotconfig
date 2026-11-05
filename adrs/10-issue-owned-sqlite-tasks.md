# 10. Local tasks associated with GitHub issues

- Status: Accepted
- Date: 2026-10-26
- Issue: Tracking issue pending creation

## Context

The retiring `todo` tool restores writable records from a Pi session journal.
Manager access to those records uses a selected worker's live endpoint. Session
ancestry and process availability therefore constrain access to work that should
outlive both.

The replacement `task` tool manages local execution steps associated with GitHub
issues. GitHub issues describe deliverables, and GitHub Projects provide
cross-repository scheduling. Task definitions and state are stored in SQLite,
not in GitHub issue bodies. Worker sessions execute tasks without defining their
identity or storage.

## Decision

Each task is associated with exactly one repository-qualified GitHub issue; an
issue can have multiple tasks. Store task definitions, state, stable identities,
dependencies, factual blockers and immutable history in local SQLite. There is
no separately addressable plan or container. SQL row identifiers are private
storage bookkeeping, not `task` API inputs or outputs.

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
issue associations; no-op operations do not advance revisions. References by
existing task ID must name its currently associated issue. Batch-local creation
aliases retain their creation-time issue qualification after a transfer.

`task` replaces `todo`. Its mutations are add, edit, status, block and transfer;
its lifecycle values are `todo | doing | done | cancelled`. Trusted host context
supplies cancellation and reopening authority, never model-authored fields.
Blocking is independent of lifecycle: a non-null `blocker` marks a task as
blocked without changing its lifecycle value. For example, a task can remain
`doing` while blocked; clearing its blocker leaves it `doing`. The
`blocked: true` read filter selects tasks with a non-null blocker. Holds and
deferral are issue-scheduling concerns. There is no `in_review` task state.

Use the existing personal Project and existing organization Project. Bind their
verified numeric **Priority** fields with their actual scopes: the personal
field is project-local, while the organization field is an issue field surfaced
in the Project. Do not create a replacement Project or a Rank field.
Remaining-delivery Fibonacci effort belongs to issue scheduling, not individual
tasks; its binding must identify the actual field and scope rather than treating
an Estimate field as an Effort field. Issues without an estimate remain in
refinement and are ineligible for assignment.

Initially, issue and Project operations follow a global Markdown rule, not a new
harness-enforced permission system. Any worker may perform the specific issue
creation, edit, split or Project-field change requested by the owner; there is
no approved-worker class. A manager role, a live manager and worker-manager
communication are not prerequisites. Existing general classification and privacy
rules still apply. Registry ownership grants no remote mutation authority or
read-only manager coding capability.

GitHub operations cannot participate in a SQLite transaction. Distinguish saved
effects, confirmed failures and unknown completion, retaining the evidence
needed to reconcile partial success. A split issue remains unscheduled until its
issue, tasks and dependencies are consistent.

Use one assignment selector across issue-next, HUD, continuation, manager views
and safe-boundary notifications. Scheduling never changes holds, renews an
allowance or starts an idle or paused worker.

## Alternatives Considered

### Read `todo` records from session journals on every offline read

- Pros: Recovers existing `todo` records without waiting for a worker endpoint.
- Cons: Keeps access coupled to session ancestry and does not make offline edits
  authoritative.
- Rejected because: The SQLite `task` store must replace session-owned writable
  `todo` state, not add another restoration path.

### Publish `todo` snapshots to a manager cache

- Pros: Removes endpoint dependence for the last published observation.
- Cons: Snapshots can omit requirements or lag writes; editable snapshots create
  another writable backlog and reconciliation protocol.
- Rejected because: A cache cannot be the authority for task records in SQLite.

### Keep execution checklists entirely in GitHub issue bodies

- Pros: Remote issue access needs no local task database.
- Cons: Issue-body updates do not provide stable transferable task identities or
  atomic cross-issue task changes; private history can become public content.
- Rejected because: GitHub stores issue descriptions and scheduling, while
  SQLite stores transactional execution tasks and private history.

## Consequences

Access through `task` does not depend on session selection or worker
availability. Local atomicity is explicit; remote partial completion remains a
reconciliation boundary rather than an exactly-once promise.

Table namespaces are not an access-control boundary. A process with whole-file
access can read registry and task data, and whole-file copies inherit both
privacy requirements. Co-location does not authorize publishing private history
or adding it to registry reports.

The `task` issue-scope decoder accepts at most 100 distinct issues per call as a
resource bound, not a scheduling limit. Larger reads paginate; oversized
mutations fail before writing rather than splitting into partial batches.

Structured VCS tools, a new daemon, registry-role redesign and messaging changes
are not prerequisites for the `task` tool.
