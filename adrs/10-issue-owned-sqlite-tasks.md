# 10. Local tasks associated with GitHub issues

- Status: Accepted
- Date: 2026-10-26
- Issue: [#255](https://github.com/0xgleb/dotconfig/issues/255)

## Context

Execution tasks need durable shared storage independent of worker availability
and session ancestry. The `task` tool manages local execution steps associated
with repository-qualified GitHub issues. GitHub issues describe deliverables,
and GitHub Projects provide cross-repository scheduling. Task definitions and
state are stored in SQLite, not in GitHub issue bodies. Worker sessions execute
tasks without defining their identity or storage.

## Decision

Each task is associated with exactly one repository-qualified GitHub issue; an
issue can have multiple tasks. Store task definitions, state, stable identities,
dependencies, factual blockers and immutable history in local SQLite. SQL row
identifiers are private storage bookkeeping, not `task` API inputs or outputs.

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

`task` mutations are add, edit, status, block and transfer. Its lifecycle values
are `todo | doing | done | cancelled`. Trusted host context supplies
cancellation and reopening authority, never model-authored fields. Blocking is
independent of lifecycle. A task's blocker is a tagged `Unblocked` variant or a
`Blocked` variant carrying a validated reason. A task can remain `doing` while
blocked; clearing its blocker leaves it `doing`. Read filters use
`blocked: "blocked"` or `blocked: "unblocked"` to select the corresponding case.
Numeric issue Priority expresses ordering; factual blockers and issue
dependencies express work that cannot proceed.

Use the existing personal Project and existing organization Project. Bind their
verified numeric **Priority** fields with their actual scopes: the personal
field is project-local, while the organization field is an issue field surfaced
in the Project. Remaining-delivery Fibonacci effort belongs to issue scheduling,
not individual tasks; its binding identifies the actual field and scope. Issues
missing Effort remain in refinement and are ineligible for assignment.

GitHub operations cannot participate in a SQLite transaction. Distinguish saved
effects, confirmed failures and unknown completion, retaining the evidence
needed to reconcile partial success.

## Alternatives Considered

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
