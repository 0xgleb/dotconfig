# Control-plane job ownership threat model

## Scope

This model covers durable `harness.research` job admission and dashboard
schedule presentation. It does not authorize a research task or grant a worker
access to a repository.

## Trust boundaries and assets

- **Loopback JSON → typed job specification:** callers can supply malformed
  ownership or scheduling data.
- **Persisted SQLite job → current runtime:** stored jobs are validated against
  the current payload contract.
- **Typed job → external read-only harness:** profile, role, project, task, and
  repository identity stay correlated; handoff text remains inert evidence.
- **Persisted timestamp → dashboard:** malformed schedules must not render as
  plausible multi-decade run ages.

Assets are project ownership boundaries, durable job history, worker isolation,
and an honest view of job state.

## Controls and verification

- **Spoofing / elevation:** ownership must exactly match the payload project and
  selected profile.
- **Tampering:** unknown ownership keys, unbounded identifiers, executable
  prompt/command fields, and profile/role mismatches fail closed.
- **Misleading presentation:** a schedule implausibly older than its own
  creation timestamp renders as `Invalid schedule`, while terminal jobs use
  `finishedAt` rather than stale `runAt`.

Verification exercises the real payload decoder/admission boundary, SQLite
persistence, and dashboard presentation helper.
