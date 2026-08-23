---
name: observability
allowed-tools:
  - Read
  - Edit
  - Write
  - "Bash(cargo test *)"
  - "Bash(cargo nextest run *)"
  - "Bash(forge test *)"
description: Use when adding logging, metrics, tracing, or event emission, or when shipping a production Rust or TypeScript service or a Solidity contract. Forces naming the on-call and indexer questions before instrumenting, then selects one signal per question with cardinality discipline.
---

Observability is a build-time practice: you instrument as part of writing the
feature, not after the first incident. Code you cannot observe is code you
cannot operate. This skill forces you to name the questions an on-call engineer
or an indexer will ask, then answer each with exactly one well-chosen signal.

## Core process

1. **Name the questions first.** Before adding a single `tracing::info!`,
   metric, or `event`, write the 2-4 questions an on-call engineer (for a
   service) or an indexer / subgraph author (for a contract) will ask FIRST when
   something is wrong. Put them in the Linear issue, the PR body, or an
   `adrs/NN-name.md` if the decision is significant. If you cannot name the
   questions, you are not ready to instrument. Examples: "Did the settlement
   loop fall behind the chain head?" "How long does an order spend between
   submit and fill?" "Which vault emitted this withdrawal and for how much
   share-value?"

2. **One signal per question.** Pick the cheapest signal that answers the
   question, and only one:
   - **Rust — "why did this happen in this case?"** → a `tracing` event
     (`tracing::warn!`, `tracing::error!`) with structured fields.
   - **Rust — "how often / how fast, in aggregate?"** → a counter or histogram
     from the `metrics` crate (`metrics::counter!`, `metrics::histogram!`).
   - **Rust — "where did the time go across async boundaries / services?"** → a
     `#[tracing::instrument]` span exported via `tracing-opentelemetry`.
   - **Solidity — anything observable off-chain** → an `event`. Events ARE the
     observability layer for a contract; there is no `tracing` on-chain. The
     `indexed` topics (max 3 per event) are your bounded labels.

3. **Structured output, enums not strings.** Emit JSON via
   `tracing-subscriber`'s `fmt().json()` layer. Event names and levels are part
   of a closed set — model them as enums, not ad-hoc string literals scattered
   across call sites (the avoid-boolean-blindness / make-invalid-states-
   unrepresentable rule applies to telemetry too). Attach a correlation id
   (order id, request id, tx hash) as a *field* so lines join across a request,
   never as part of the message text.

4. **Cardinality discipline.** Metric labels and `indexed` Solidity topics must
   come from bounded sets (chain id, status enum, provider name, error variant).
   NEVER put an address, tx hash, order id, vault id, or token amount in a
   metric label — it explodes the time-series backend. NEVER burn one of the
   three `indexed` Solidity topics on an unbounded value either; those belong in
   the event's non-indexed data, where an indexer reads them per-log.

5. **Verify like a test (TTDD).** Telemetry is code; prove it works before
   calling the feature done:
   - Induce the failure in staging (or a local devnet) and confirm you can find
     it from telemetry ALONE — no source diving, no `println!`.
   - For Solidity, assert the event with `vm.expectEmit` inside a `forge test`,
     checking the indexed topics and data you claim to emit.
   - For Rust, write a test that captures the subscriber output (or asserts the
     metric registry) and checks the event/field/label is actually emitted on
     the real code path, not a contrived shortcut.

## Common rationalizations

| Excuse | Reality |
| --- | --- |
| "I'll add tracing after the service is working." | "After" is the first 3 a.m. incident — the most expensive possible moment to discover you are blind. Instrument with the feature. |
| "More logs = more observability." | 300 prose lines you cannot query are worse than three structured events with stable names and fields. Noise hides the signal during an incident. |
| "`println!` / `dbg!` / `console.log` is fine for now." | It cannot be filtered by level, correlated by request id, JSON-parsed, or alerted on. It is not telemetry; it is litter that ships to prod. |
| "I'll just put the order id in the metric label so I can filter." | That is unbounded cardinality — it will take down the metrics backend. The order id goes in a `tracing` field or the event data, never a label or an `indexed` topic. |
| "Averages are good enough for latency." | An average hides the p99 that pages you. Report percentiles (histograms), never means. |
| "It's just an internal helper event, the ABI doesn't matter." | Emitted Solidity events are part of the contract's external interface — indexers and subgraphs depend on them. Changing one is an interface change (see interface-lifecycle). |

## Red flags

- A PR adds retries, a queue, a settlement loop, or an external RPC call and
  ships ZERO new telemetry.
- Log lines built by string interpolation (`format!("order {id} failed")`)
  instead of structured fields (`tracing::warn!(order_id = %id, "order failed")`).
- No correlation id (order id / request id / tx hash) threaded through the logs
  and spans of a single request.
- A metric label or `indexed` Solidity topic holds an address, tx hash, order
  id, vault id, amount, or free-form error text.
- Latency tracked as an average / sum-over-count instead of a histogram with
  queryable p95 / p99.
- Event names or levels written as bare string literals at each call site
  rather than a shared enum.
- A new `event` added to a deployed contract with no `vm.expectEmit` test and no
  note that the ABI/interface changed.
- `println!`, `dbg!`, or `console.log` left in a code path that runs in prod.
- The only evidence the feature works is "it ran on my machine."

## Hard rules

- **Never use `println!`, `dbg!`, `eprintln!`, or `console.log` as production
  telemetry.** Use `tracing` (Rust) / a structured logger (TS) / `event`
  (Solidity).
- **Never log secrets, keys, seed phrases, private keys, or token/PII values**,
  and never log raw amounts where a balance could be reconstructed. This
  reinforces the global absolute prohibition on touching credentials — telemetry
  is a common accidental leak path.
- **Report percentiles, never averages**, for any latency or duration signal.
- **One signal per question.** Do not answer the same question with a log AND a
  metric AND a span "to be safe" — pick the right one.
- **Bounded labels only.** Metric labels and `indexed` Solidity topics come from
  closed sets. Unbounded values go in fields / event data.
- **Emitted Solidity events are external interface.** Adding, removing, or
  changing an event's shape is an interface change governed by the
  interface-lifecycle discipline — version and document it, do not silently
  mutate a deployed contract's event signature.
- **No instrumentation without the questions written down** in the issue, PR, or
  an ADR.

## Failure modes

- **Cardinality blowout:** an unbounded label (address, order id) silently
  multiplies time-series until the metrics backend degrades or drops data. The
  fix is structural, not a config tweak — move the value off the label.
- **Telemetry that lies:** the metric/event is emitted from a test-only or
  happy-path branch, not the real failing code path, so it never fires when it
  matters. Reproduce a real failure and confirm the signal appears.
- **Trace breaks at the gap:** context is not propagated across an async
  boundary or a service hop, so the span tree dies and "where did time go?"
  becomes unanswerable. Propagate the context on every boundary.
- **Event signature drift:** an `event` is changed to add a field or flip
  `indexed`, silently breaking every indexer/subgraph decoding the old ABI.
  Treat it as a breaking interface change.
- **Secret leak via logs:** a struct with `#[derive(Debug)]` is logged whole and
  carries a key or amount. Implement a redacting `Debug`/`Display` or log only
  the named safe fields.

## Verification

"Seems right" is never acceptable. Before the feature is done:

- The on-call / indexer questions are written down, and each maps to exactly one
  signal (event, metric, span, or contract `event`).
- All Rust logs are structured JSON with stable, enum-backed event names and a
  correlation id field; no `println!`/`dbg!` in prod paths.
- No metric label or `indexed` Solidity topic carries an unbounded value;
  grepped and confirmed.
- Latency is a histogram with queryable p95/p99 — not an average.
- A `forge test` with `vm.expectEmit` asserts each new contract event's topics
  and data; `cargo test` / `cargo nextest run` covers each new Rust signal on
  its real code path.
- You induced the target failure in staging or a local devnet and located it
  from telemetry alone — no source diving, no added `println!`.
