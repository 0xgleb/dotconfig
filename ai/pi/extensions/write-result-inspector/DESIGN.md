# Write-result micro-inspector design

## Scope

After a successful built-in `edit` or `write`, run the smallest useful feedback
loop before the next agent action:

1. inspect only the exact successful mutation input;
2. run an allowlisted deterministic syntax/format check for the changed file;
3. if deterministic checks are clean, run one tool-less GPT-5.6 Luna pass with
   only relevant local-language inspectors;
4. return validated typed findings on the leading tool result.

The inspector never authorizes another operation, mutates files, searches the
repository, reads arbitrary neighboring source, or performs architecture,
invariant, external-contract, security, financial, risk, or other cross-file
review. Those judgments remain in complete feature or pull-request review.

## Verified constraints

- Pi `tool_result` handlers may perform nested asynchronous work, patch content,
  details, and usage, and use `ctx.signal` for cancellation.
- Tool-result middleware runs in extension load order. This extension must load
  before `classified-workflows` so the normal result boundary sees its bounded
  advisory output.
- Parallel tool results may interleave. A short shared batch window is required
  to avoid one model call per sibling edit.
- Nested model usage must be returned on the tool result so session accounting
  includes it.
- Session reload invalidates captured extension contexts. No post-await UI or
  session API call is permitted.
- Secret-bearing paths must never be read or sent to the model.

## Design A — synchronous tool-result middleware (chosen)

### Caller shape

The writing agent continues to call built-in tools normally:

```text
edit(...) -> successful tool result + optional micro-inspection findings
write(...) -> successful tool result + optional micro-inspection findings
```

No new tool or agent instruction is required.

### Types

```ts
type MutationDelta = {
  toolCallId: string
  path: string
  language: InspectableLanguage
  exactChangedText: string
}

type InspectionFinding = {
  source: "deterministic" | "luna"
  inspector: InspectorKind
  severity: "error" | "warning" | "info"
  code: string
  message: string
  line?: number
}

type ContextRequest = {
  judgment: "architecture" | "invariant" | "external-contract"
  reason: string
  symbols: string[]
}

type InspectionOutcome =
  | {
      status: "findings"
      findings: InspectionFinding[]
      contextRequests: ContextRequest[]
    }
  | { status: "clean" }
  | { status: "skipped"; reason: SkipReason }
```

Model output is decoded into this closed type. Unknown fields, paths,
inspectors, severities, oversized strings, and out-of-range lines are rejected.
The trusted changed path is attached locally; the model cannot select a target.

### Ownership and lifecycle

- `core.ts` owns path safety, exact-delta extraction, inspector selection,
  instruction selection, limits, and model-output decoding.
- `deterministic.ts` owns the fixed command allowlist and typed check outcomes.
- `inspector-process.ts` owns one tool-less Luna subprocess and usage decoding.
- `index.ts` owns batching, session cancellation, middleware wiring, and result
  patching.
- A session-scoped epoch and abort controller invalidate pending batches on
  shutdown/reload. Handlers return data only; they never touch `ctx` after an
  await.

### Bounds

- successful `edit`/`write` only;
- workspace-contained input paths only; final-component symlinks fail closed;
- no credential-shaped paths or high-confidence credential material in deltas;
- deterministic import-boundary checks reject changed relative/file imports that
  escape the workspace or enter protected roots;
- at most 8 mutations, 4 files, 24 KiB exact changed text, 1 MiB per checked
  post-state file, and 12 KiB loaded project instructions per batch;
- 150 ms coalescing window;
- allowlisted deterministic commands run concurrently with 4 s deadlines;
- one Luna call, no tools, one attempt, low thinking, 15 s deadline;
- the extension-owned worst case is 19.15 seconds; normal downstream Pi
  tool-result policy processing remains outside this extension's latency budget;
- deterministic failure skips Luna;
- unsupported, oversized, cancelled, unavailable, or malformed cases preserve
  the successful write and return a typed skip rather than failing it.

### Test surface

- protected/outside-workspace paths never become deltas;
- edit blocks and write content remain exact and bounded;
- only relevant inspectors are selected;
- nearest loaded `AGENTS.md` wins without unrelated context;
- model output cannot add paths, authority, arbitrary categories, or oversized
  text;
- architecture/invariant/contract claims can decode only as inert context
  requests for compatibility, while the normal micro-prompt requires an empty
  context request list and defers them to feature/PR review;
- sibling mutations coalesce and only the leader patches the result;
- shutdown/cancellation prevents stale-context work;
- deterministic failures prevent model launch;
- nested usage is returned with the tool-result patch.
- first activation is verified with one controlled in-workspace mutation; roster
  registration alone does not prove middleware execution or usage accounting.

### Measured cost and boundary

A 2026-08-28 local sample used the same tool-less GPT-5.6 Luna/low subprocess
shape on three synthetic TypeScript, Rust, and Nix local-style deltas. All three
completed successfully in 5.20s, 6.32s, and 6.77s. They used 137/13, 128/13,
and 124/13 input/output tokens respectively (137–150 total tokens). One earlier
sample completed in 5.33s. At Luna catalog rates, each measured call is roughly
$0.00004, but the median added latency is about 5.83s before deterministic
checker time.

The calls are token-cheap but not interaction-cheap. Do not add another model
stage or widen automatic context. Keep one coalesced call per logical write,
require every finding to be directly provable from the exact delta or an
explicit project instruction, and restrict it to imports, qualified-use
conventions, formatting, local style, and local test quality. The closed decoder
still accepts bounded context requests defensively, but the normal prompt tells
the model to leave them empty and defer all cross-file judgments.

### Falsification evidence

Redesign if tool-result middleware is not awaited before the next provider turn,
if sibling handlers cannot share a batch safely, if common deterministic checks
routinely exceed the latency budget, or if the measured 5–7 second Luna delay
makes per-write ordering more costly than the findings it prevents.

## Design B — asynchronous observer plus later advisory message (rejected)

This design would return every write immediately, inspect in the background,
and later call `pi.sendMessage(..., { deliverAs: "steer" })` with findings.

It improves immediate write latency, but loses the key contract: the next model
turn may start before the advisory arrives. It also introduces a stale-context
hazard because a model call can cross reload and then attempt to inject through
an old extension API. Persisting and replaying advisories would add branch and
session ownership state for a feature that should remain local to one tool
result.

Design B loses on lifecycle safety, result locality, and deterministic ordering.
It becomes viable only if measured Luna latency makes Design A unusable and Pi
adds a source-fixed post-tool barrier that accepts late typed results.

## Rollback

Remove the extension from `package.json`; built-in `edit` and `write` behavior is
unchanged because the extension observes successful results and never overrides
execution.
