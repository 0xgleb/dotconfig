# Control-plane job ownership threat model

## Scope

This model covers durable `harness.research` job admission, persisted legacy-job reconciliation, and dashboard schedule presentation. It does not authorize a research task or grant a worker access to a repository.

## Trust boundaries and assets

- **Loopback JSON → typed job specification:** callers can mislabel project-domain research as an `agentops-*` lane or supply malformed scheduling data.
- **Persisted SQLite job → current runtime:** legacy rows predate ownership typing and must remain readable without becoming valid templates for new work.
- **Typed job → external read-only harness:** profile, role, project, task, and repository identity must stay correlated; handoff text remains inert evidence.
- **Persisted timestamp → dashboard:** malformed legacy schedules must not render as plausible multi-decade run ages.

Assets are project ownership boundaries, agentops support capacity, durable job history, worker isolation, and an honest operator view of job state.

## STRIDE and required failing tests

- **Spoofing / elevation:** ownership must repeat and exactly match the payload project; an `agentops-<project>` profile marked as project-domain work, or an agentops support owner whose role does not exactly match its project, must be rejected at new-job admission.
- **Tampering:** unknown ownership keys, unbounded identifiers, unsupported support areas, executable prompt/command fields, and profile/role mismatches must fail closed.
- **Repudiation:** legacy active `agentops-*` research is cancelled through an ordinary typed job transition; terminal history is preserved and never rewritten.
- **Information disclosure:** reconciliation selects only typed job metadata and never logs task output, credentials, or repository contents.
- **Denial of service:** reconciliation is bounded to the existing finite job-store list and only transitions nonterminal legacy `agentops-*` research once; repeated startup is idempotent.
- **Misleading presentation:** a schedule implausibly older than its own creation timestamp must render as `Invalid schedule`, while terminal jobs use `finishedAt` rather than stale `runAt`.

The first regressions must exercise the real payload decoder/admission boundary, SQLite transition path, and dashboard presentation helper before implementation is added.
