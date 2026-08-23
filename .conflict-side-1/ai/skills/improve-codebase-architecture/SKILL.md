---
name: improve-codebase-architecture
description: Audit an existing codebase or named subsystem for evidence-backed architecture improvements by finding shallow modules, pass-through layers, scattered ownership, weak seams, and hard-to-test interfaces; trigger on /improve-codebase-architecture, “improve the architecture”, “architecture audit”, “find refactor opportunities”, or “where should we deepen this codebase”, but stop before designing or implementing a selected change.
user-invocable: true
---

# Improve codebase architecture

Find the architectural changes most likely to reduce recurring maintenance cost. Report candidates first. Do not design interfaces or modify code until the user chooses one.

## Route the work first

Use another workflow when:

- the user already chose a change and wants its types, signatures, or module structure designed: use `architect`;
- intent or success criteria are vague: use `shape-work`;
- an existing diff needs review rather than a standing-code audit: use `architecture-direction-inspector`;
- a confirmed expensive-to-reverse decision needs recording: use `adr`;
- a public interface, storage layout, or migration is involved: include `interface-lifecycle`.

## Phase 1: Choose the search area

1. Use the subsystem, module, pain point, or direction named by the user.
2. If no area was named, inspect a bounded stretch of recent history to find files and modules that change repeatedly.
3. Prefer recurring hotspots over a repository-wide theoretical redesign.
4. Read applicable project instructions, architecture documents, ADRs, tests, and public contracts. Do not assume any fixed file layout such as `CONTEXT.md` or `docs/adr/`.
5. State the selected scope and why the available evidence makes it worth inspecting.

## Phase 2: Trace the current shape

For the selected area, trace:

- callers and public interfaces;
- ownership of state, effects, persistence, and lifecycle;
- dependency direction;
- invariants and error handling;
- test entry points;
- facts callers must know that the module should hide;
- changes that currently require edits in several places.

Distinguish repository evidence from analysis. A file name, class name, or large line count is not evidence of an architectural problem by itself.

## Phase 3: Find candidates

Look for:

- shallow modules whose interface is nearly as complicated as their implementation;
- pass-through layers that add names and call depth without hiding knowledge;
- concepts whose state or invariants are split across unrelated owners;
- dependency direction that makes stable policy depend on volatile details;
- tests that must bypass the public interface to reach important behavior;
- repeated changes that cross the same files or boundaries;
- speculative seams with only one concrete implementation;
- public interfaces that expose ordering, configuration, or lifecycle rules callers should not manage.

Apply these checks:

### Deletion test

Imagine removing the suspected abstraction.

- If its complexity disappears, it was probably pass-through structure.
- If its complexity spreads into several callers, it is hiding real work.
- Do not recommend deletion until the affected callers and behavior are traced.

### Interface depth

Prefer a smaller interface that hides more behavior and required knowledge. Do not measure depth by implementation line count.

### Evidence for a seam

A seam is strongest when real behavior varies across it. One hypothetical future implementation is not enough. Two concrete variations, external contract separation, or a demonstrated test boundary can justify it.

### Locality

Prefer changes that put ownership, invariants, effects, and verification in one place. Reject changes that merely redistribute the same knowledge across new files.

## Phase 4: Report candidates

For each candidate, provide:

1. **Scope:** exact files and modules involved.
2. **Observed friction:** repository evidence, including repeated changes, caller knowledge, test difficulty, or ownership splits.
3. **Deletion test:** what happens if the current abstraction is removed.
4. **Direction:** the architectural change in plain language, without designing the final interface.
5. **Expected benefit:** what knowledge, change, or verification becomes local.
6. **Risk:** compatibility, migration, lifecycle, performance, or rollback concerns.
7. **Confidence:** `strong`, `worth exploring`, or `speculative`, with the evidence behind the rating.
8. **Falsification:** what additional evidence would show the recommendation is wrong.

End with one top recommendation and explain why it should be investigated first.

Use compact Markdown by default. Produce HTML, diagrams, or browser-opened reports only when the user asks for them.

## Phase 5: Stop at selection

Ask which candidate the user wants to explore. Do not silently move from audit into design or implementation.

After selection:

- use `shape-work` if requirements or non-goals remain unclear;
- use `architect` to compare caller-first type, signature, and module designs;
- use `interface-lifecycle` for compatibility and migration;
- use `adr` when the decision meets the repository’s ADR criteria;
- run the applicable threat model before changes involving money, trust, access control, untrusted input, external integrations, or LLM tools.

## Hard rules

1. Never recommend architecture from aesthetics, naming preference, file size, or generic best practices alone.
2. Never invent project direction, domain language, ADRs, callers, or future implementations.
3. Never force a fixed vocabulary or rewrite established domain terms.
4. Never introduce a seam, adapter, interface, or module without evidence that it hides complexity or real variation.
5. Never require `CONTEXT.md`, a specific ADR directory, CDN assets, OS browser launching, or an external grilling tool.
6. Never write code, mutate architecture documents, commit, or publish during the candidate-report phase.
7. Never re-litigate a documented decision without new friction strong enough to justify reopening it.
8. Prefer no recommendation over a speculative refactor that cannot be falsified.
