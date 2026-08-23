# 04. Use semantic classification with typed operational boundaries

- Status: Proposed
- Date: 2026-07-24
- Issue: None (personal configuration change; no tracker issue)

## Context

ADR 01 established a fail-closed classifier around Pi actions and reserved
deterministic logic for hard prohibitions and intrinsically safe operations. The
implementation drifted into a growing set of command-specific regular expressions
and prompt exceptions after individual false blocks. That approach duplicated
natural-language intent in code, lost evidence between related operations, and
still produced contradictory decisions. In particular, verified pending-review
comments were repeatedly blocked after the exact head, source lines, and review
plan had already been checked.

The classifier must preserve hard safety boundaries without requiring every new
workflow to teach a shell parser the user's language or command shape. It also
must retain relevant evidence across a multi-step operation without sending the
entire session transcript to every classification call.

## Decision

Keep deterministic classification only for general invariants that are decidable
from typed structure alone: protected-path denial, strict resource limits,
forbidden submitted-review verdicts or non-empty top-level bodies, and result
allowances tied to an already-authorized exact tool call. Deterministic code must
not infer conversational authorization or encode task-specific natural language.

Use the strongest authenticated GPT-5.6 semantic tier (`openai-codex/gpt-5.6-sol`)
for unresolved authorization decisions. Assemble its context from current human
intent, active goals and todos, loaded instructions, active skill procedures, and
a bounded evidence window. Keep recent evidence and retrieve older evidence by
concrete identifiers present in the proposed boundary, such as paths, commit IDs,
PR numbers, review IDs, branch IDs, and package names.

Replace repeated shell-level domain protocols with typed tools. A typed tool owns
its structural invariant and effect boundary; the semantic classifier decides
whether the requested typed operation is authorized in context. For example,
pending-review staging accepts an empty top-level body and structured inline
comments and cannot represent a verdict submission. The tool may persist a
bounded authorization/plan record so related operations retain evidence
continuity without reclassifying prose or reparsing shell commands.

Refactor the monolithic classifier policy toward a catalog of named general
invariants and domain policies. Select only policies relevant to the boundary,
while always including hard prohibitions. New false-block fixes should improve
context assembly, a general policy, or a typed domain boundary. They must not add
a one-off command regex unless the regex enforces syntax for a hard invariant.

## Alternatives Considered

### Continue adding command-specific deterministic exceptions

- Pros: Fast to patch, cheap at runtime, and straightforward to unit test for one
  observed command.
- Cons: Reimplements natural-language authorization as brittle regexes, creates
  ordering interactions, and requires endless variants for equivalent commands.
- Rejected because: The observed false blocks persisted while the guard code grew
  less maintainable and less semantically correct.

### Send the complete transcript to a small classifier model

- Pros: Minimal local architecture and no evidence-selection code.
- Cons: Stale and unrelated context dominates the decision, latency and token use
  grow without bound, and a smaller model still misses relationships between the
  proposed operation and earlier evidence.
- Rejected because: More undifferentiated context is not the same as relevant
  context, and prior Luna decisions repeatedly ignored verified evidence.

### Make every action deterministic and remove the LLM classifier

- Pros: Reproducible, fast, cheap, and easy to audit mechanically.
- Cons: Typed structure cannot establish whether a consequential action is aligned
  with conversational intent, especially across repositories and evolving tasks.
- Rejected because: Hard invariants are mechanically decidable, but authorization
  remains semantic.

## Consequences

Semantic classification costs more and can take longer because it uses Sol rather
than Luna. Bounded relevance retrieval limits that cost and makes the supplied
context inspectable. Classification remains fail-closed when context is genuinely
insufficient.

Typed domain tools add implementation work, but they make invalid operations
unrepresentable and remove shell quoting and parser ambiguity. Their persisted
plans must be bounded, session-scoped, auditable, and invalidated when the target
head or policy digest changes.

Existing one-off classifier rules are technical debt. They should be retired as
typed boundaries and general policy modules cover their domains. Hard credential,
verdict, external-publication, and resource-limit guards remain deterministic and
non-overridable.
