# Subscription usage governor threat model

## Invariant

Genuine interactive or RPC prompts retain the operator-selected model and an available composer, but they do not bypass shared-provider accounting. Every OpenAI provider call requires a live loopback reservation regardless of human, responsive, or autonomous origin. Extension, polling, reload, and operational turns additionally require outer admission. Classified workflow fan-out receives a separate token-budget decision and cannot exceed the continuously scaled grant. Missing or malformed control state fails closed; it never silently changes provider or model.

## Boundaries and controls

- Input origin is untrusted state: only Pi's `interactive` and `rpc` input sources, plus an exact short-lived Pi-Vim human-follow-up event, open the immediate human lane.
- Extension-generated turns default to autonomous. Every OpenAI provider call in every lane must reserve budget before dispatch; neither human origin nor outer-run admission is a spending bypass because one prompt can drive many tool-loop provider calls.
- Provider usage and model metadata cross a runtime boundary. Requested token estimates are bounded before reservation, and only the finalized assistant message's typed usage can settle a reservation.
- Reservation identity and lifecycle cross process and reload boundaries through loopback HTTP and SQLite. Reserve/settle operations are idempotent, conflicting duplicate settlements fail closed, abandoned reservations expire, and concurrent callers cannot overspend the same balance.
- ChatGPT UI and Codex app-server checkpoints are evidence sources for OpenAI subscription capacity, not additive meters. The controller selects one coherent fresh observation series, estimates recent percentage burn, computes permitted burn while preserving reserve, and calibrates percentage burn against observed OpenAI token deltas. Capacity above 100% remains subject to the same measured runway controller; it never becomes an unthrottled bypass. Distinct accounts may be summed only when explicit account identity proves they are different. An owner-verified refill with no displayed reset is stored as an explicit refill event; a planning horizon may pace work but must never be presented or persisted as a provider reset.
- Provider-call reservations carry the authenticated Pi session id and cwd. Durable per-agent intervention timestamps determine a smoothly decaying allocation weight with a nonzero progress floor. ST0x sessions receive a configured 2× base weight; role names alone never grant that weight. A direct owner turn updates its own agent, while a successful owner-directed registry delegation records the intervention against the receiving lease owner rather than the intermediary.
- At or below the hard reserve, autonomous OpenAI calls and workflow token grants fail closed. Above reserve, the sample-derived token bucket is the primary control; recurring wake cadence remains only a reconciliation fallback.
- Settlements never grant task authority or change model/tool scope. Model output cannot choose the role, pool, reservation identity, or recorded usage.
- The last operator-selected model is persisted as a bounded provider/id pair; malformed state is rejected.
- No credentials, prompt bodies, or model output are persisted or logged. Reservation records contain only bounded identifiers, role/provider, timestamps, and token counts.

## Abuse regressions

- Extension input cannot impersonate an interactive prompt.
- Reload and polling messages have no human marker, so they require allowance admission.
- A later genuine human prompt restores the persisted operator-selected model.
- One admitted run, including a human-origin run, cannot issue an unbounded tool-loop sequence of OpenAI calls.
- Two concurrent reservations cannot both spend the same remaining token balance.
- Replaying an identical settlement is idempotent; changing its token count or settling an unknown reservation is rejected.
- Expired reservations cannot create free budget or erase late provider usage.
- Malformed, negative, overflowing, forged-provider, missing-agent, and stale-cycle reservation inputs fail closed.
- Agent allocation decays toward a nonzero floor, preserves FIFO aging inside weighted contention, and gives equal-recency ST0x agents exactly twice another agent's allocation.
- An owner-directed registry relay updates the receiving agent's intervention timestamp; ordinary agent coordination and failed or unowned delegation do not invent an owner intervention.
- A 100% owner-verified bailout with no reset is accepted without reusing the stale prior reset timestamp.
- Reserve state returns a zero provider-call and workflow grant, so frequent backup ticks cannot spend OpenAI allowance merely by firing.
- A stale manual checkpoint cannot hide fresher lower provider evidence from provider-call admission, and source reconciliation cannot delete, relabel, double-count, or overwrite observation history.
