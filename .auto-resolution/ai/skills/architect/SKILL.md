---
name: architect
description: Design non-trivial code changes before implementation by grounding affected systems, sketching caller-first types, signatures, and module boundaries, comparing at least two complete designs, then implementing and redesigning if repeated friction disproves the shape; trigger on /architect, “architect this”, “design this”, or work where coding first would lock in the wrong structure, but not vague intent shaping, implementation-plan review, ADR recording, or post-hoc architecture review.
user-invocable: true
---

# Architect

Design the shape of a non-trivial change before filling in implementation details, then keep the design accountable to what implementation reveals.

## Route the work first

Use the nearest dedicated workflow instead when:

- intent, requirements, or non-goals are still vague: use `shape-work`;
- a concrete implementation plan already exists: use `review-plan`;
- a significant decision is agreed and must be recorded: use `adr`;
- an existing diff needs architectural review: use `architecture-direction-inspector`;
- a public interface, storage layout, or consumer migration is changing: include `interface-lifecycle`;
- the change crosses a threat-model trigger: run `threat-model-first` before design.

Return here once the design question is concrete.

## Phase 1: Ground

1. Read the relevant code, tests, project instructions, ADRs, and public contracts.
2. Trace callers, ownership, state transitions, effects, error paths, persistence, and lifecycle.
3. Write down verified constraints and unresolved assumptions. Do not turn repository convention or guessed intent into a requirement.
4. Skip only the parts that are genuinely greenfield.

## Phase 2: Design twice

Produce at least two structurally different complete designs. Point fixes inside the same shape do not count.

For each design, write:

1. Caller usage first.
2. Domain types and invalid states that must be unrepresentable.
3. Function signatures and typed failures.
4. Module ownership and dependency direction.
5. State, effect, persistence, and lifecycle boundaries.
6. Migration and compatibility needs.
7. The smallest test surface that proves the contract.
8. Costs, risks, and the evidence that would falsify the design.

In Pi, use a bounded read-only `workflow` when independent design perspectives add value. In another harness, use its equivalent isolated-agent path. If delegation is unavailable, produce the two designs sequentially rather than skipping the comparison.

## Phase 3: Choose the shape

Compare the designs against repository evidence:

- Which interface hides more implementation complexity?
- Which design keeps knowledge and changes local?
- Which dependencies point toward stable policy rather than volatile details?
- Which design removes pass-through layers under the deletion test?
- Is each proposed seam backed by real variation rather than a hypothetical second implementation?
- Which design makes malformed state and expected failure explicit?
- Which design has the safer migration and rollback path?

Choose one design and state why the alternatives lost.

Pause for human agreement when the user asked for a checkpoint, when the decision is expensive to reverse, or when it changes a public, persisted, financial, custody, or security boundary. Record an ADR when the local ADR criteria are met.

## Phase 4: Implement against the design

1. Turn the chosen design into small vertical slices.
2. Keep caller usage, types, signatures, module ownership, and typed failures visible.
3. Run the narrowest relevant check after each slice.
4. Treat every deviation as evidence. Explain whether it came from a missed requirement, a false assumption, or implementation overreach.
5. Do not hide design failure behind casts, optional fields that are always present, fallback values, shared mutable state, or pass-through wrappers.

## Phase 5: Redesign when evidence wins

One difficult edge case does not invalidate a design. Re-ground and design again when the same friction appears independently more than once, for example:

- repeated escape hatches in types;
- callers needing internal knowledge;
- the same special case across unrelated paths;
- ownership or locking that contradicts the design;
- multiple deviations with the same underlying cause.

Carry verified implementation lessons into the next design. Subtract accidental structure before adding another layer.

## Outputs

For a small change, produce one design note containing caller usage, types, signatures, ownership, rationale, and validation.

For a larger change, add a module map, dependency direction, state transitions, migration plan, rollback path, and explicit falsification evidence.

## Hard rules

1. Never use this skill to bypass `shape-work`, `adr`, `interface-lifecycle`, or `threat-model-first`.
2. Never treat generated alternatives as evidence. Verify them against the repository.
3. Never create speculative seams, adapters, or abstractions without demonstrated variation or complexity they hide.
4. Never let a design sketch authorize implementation, commits, publication, or cross-project mutation.
5. Keep parallel design work read-only unless each mutating worker has an approved isolated worktree.
6. If implementation repeatedly disproves the chosen shape, redesign instead of patching around it.
