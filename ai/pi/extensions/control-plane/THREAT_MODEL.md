# Pi control-plane threat model

## Trust boundaries

1. **Loopback HTTP JSON → typed job request.** Browser, CLI, and model-mediated
   callers are untrusted until the registered job-kind decoder accepts the whole
   payload.
2. **Worker claim/heartbeat/result → current attempt.** A session or stale process
   can present an old worker identity or lease token after expiry/reassignment.
3. **Persisted SQLite rows → domain state.** Corruption, partial migration, or a
   newer schema can violate the discriminated-union invariants.
4. **Model output → job lifecycle.** A completion may describe work but cannot
   register a job kind, supply executable code, or authorize a transition.
5. **Dashboard/Telegram command → control transition.** Authentication identifies
   the caller; it does not itself grant cancellation, retry, repository, review,
   deployment, wallet, or approval authority.

## Assets

- The true job state, attempt count, schedule, and terminal outcome.
- Exclusive ownership of a live attempt.
- Existing classifier and project-tool authority boundaries.
- Bounded, non-sensitive audit history.
- Scheduler availability under malformed or excessive input.
- The user's local session and repository state, which a job payload must never be
  able to mutate directly.

## STRIDE controls

| Threat | Concrete abuse | Required control and test |
| --- | --- | --- |
| Spoofing | A stale worker completes a reassigned attempt. | Random per-attempt lease token, expiry, and compare-and-set terminal write; stale-token tests. |
| Tampering | A caller submits an unknown kind, arbitrary command, invalid profile, impossible timestamp, or jitter wider than its base. | Exact decoders, registered discriminated unions, safe arithmetic, bounded fields; untrusted enqueue tests. |
| Repudiation | A worker denies claiming, abandoning, retrying, or cancelling work. | Transactional Attempt rows and append-only bounded Events tied to worker and lease token. |
| Information disclosure | A payload, error, event, or dashboard response carries credentials or raw model/tool output. | Registered payload schemas, protected-path guards, bounded summaries, safe read models, and no arbitrary blobs. |
| Denial of service | Huge payloads, unbounded attempts, distant schedules, lease overflow, or event growth wedge the service. | Request/body/field limits, maximum attempts and delays, checked timestamp arithmetic, retention policy, busy timeout, and malformed-boundary tests. |
| Elevation of privilege | A loopback client or leased job runs shell, invokes a tool, or treats model text as approval. | No executable payload kind; job lease is routing only; existing classifier and constrained tools re-check authority at action time. |

## First abuse-case tests

`job-runtime.test.ts` was run red before the runtime implementation. It covers:

- unknown executable job kinds and invalid review profiles;
- oversized idempotency keys and invalid recurrence jitter;
- early claims and invalid lease lifetimes;
- stale lease success/failure publication;
- first-writer-wins terminal transitions;
- cooperative cancellation for live attempts;
- retry/abandon behavior bounded by maximum attempts;
- refusal to reclaim an unexpired lease.

The SQLite adapter and HTTP server must add red tests for concurrent atomic claim,
duplicate idempotent enqueue, schema corruption/version drift, oversized bodies,
unknown routes/methods, non-loopback binding, event redaction, lease heartbeat and
expiry races, and service restart recovery before those boundaries are implemented.
