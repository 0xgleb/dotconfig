---
name: interface-lifecycle
description: Use when designing or changing a public surface others depend on (a Rust crate pub API or trait, a Solidity external or public function, event, or storage layout, or a module boundary between services), when judging whether a change is backward compatible, or when planning a safe incremental migration or removal of consumers, state, or on-chain liquidity.
user-invocable: true
allowed-tools:
  - Read
  - Grep
  - Glob
  - "Bash(cargo semver-checks *)"
  - "Bash(cargo public-api *)"
  - "Bash(forge inspect *)"
  - "Bash(rg *)"
  - "Bash(git grep *)"
  - "Bash(git log *)"
  - "Bash(git diff *)"
  - Write
  - Edit
---

A public surface is a promise. This skill governs the whole lifecycle of anything
others depend on — a `pub` Rust item or trait, a Solidity `external`/`public`
function, an emitted event, a storage layout, or a module boundary between
services — from first design through additive evolution to safe removal.

Use it for two questions that are really the same question: "is this change
backward compatible?" and "how do I retire this without breaking a consumer or
stranding liquidity?"

## Stability: designing and evolving the surface

1. **Enumerate the surface before you touch it.** You cannot reason about
   compatibility you have not listed.
   - Rust: `cargo public-api` for the full exported set; `cargo semver-checks`
     to diff against the published version.
   - Solidity: `forge inspect <Contract> abi` for external functions and events,
     `forge inspect <Contract> storageLayout` for slot assignments, `forge
     inspect <Contract> methods` for selectors. (Confirm subcommand names with
     `forge inspect --help`.)
   - Module boundaries: `rg`/`git grep` for every import of the boundary type.

2. **Contract-first: pin the signature, then write the failing test.** Define the
   trait method, function signature, or ABI and write a test that compiles and
   fails against it *before* any implementation. The type is the spec; the test
   is the proof. No impl logic until a compiled, failing test asserts the
   contract.

3. **Apply Hyrum's Law — list the behaviors the type signature does NOT
   capture.** With enough consumers, every observable behavior gets depended on.
   Write down each one and treat it as a binding commitment that tests of the
   happy path do not protect:
   - revert/error strings and custom-error selectors,
   - event field order and which fields are `indexed`,
   - ABI encoding, tuple ordering, return-value packing,
   - default/zero values, iteration order, rounding direction,
   - gas costs that consumers may have hard-coded.

4. **Evolve additively, never by retyping or removing.**
   - Rust: mark public enums/structs `#[non_exhaustive]` so variants/fields can
     grow; seal traits you do not want implemented downstream; add new optional
     fields or new methods with defaults rather than changing existing
     signatures.
   - Solidity: append new storage slots only — never reorder, retype, or remove
     an existing slot (especially behind a proxy); never change a deployed
     `external` signature; add a new function or event instead of mutating one.

5. **One-Version Rule.** Keep a single workspace version and dedup dependencies —
   one resolved version per crate in `Cargo.lock`, deduped Nix flake inputs — so
   consumers never face a diamond-dependency choice. Forking into two live
   versions multiplies maintenance and is the thing you are trying to avoid.

## Removal and migration: retiring the surface

6. **Run the 5-question removal decision, then write an ADR and STOP.** Before
   deprecating anything, answer:
   1. Is it still used (and by what traffic/call volume)?
   2. Who depends on it — which crates, contracts, services, or counterparties?
   3. What replaces it?
   4. Is the migration advisory or compulsory?
   5. What is the concrete cutover mechanism and rollback?

   Record the decision as an ADR at `adrs/NN-name.md`, summarize it for the user,
   and stop for review before proceeding. Removal of a depended-on surface is a
   significant architectural decision.

7. **Build the replacement first, and prove it in production.** Never deprecate
   toward a surface that does not yet exist and carry real load. The new path
   must be production-proven before the old one is even marked deprecated.

8. **Enumerate consumers concretely — do not estimate.**
   - Rust: `#[deprecated(note = "use X")]` so `cargo build` emits a warning at
     every call site; `rg`/`git grep` to count references across the workspace.
   - Solidity: there is no compiler to ask — read on-chain events and state, and
     `rg` the integrating repos, to find who actually calls the function or holds
     the position.

9. **Model advisory-vs-compulsory as a discriminated union, not a boolean.** A
   raw `bool deprecated` is boolean blindness. Represent the policy as
   `enum Deprecation { Advisory { since }, Compulsory { since, cutover_at,
   replacement } }` (or the Solidity equivalent) so the cutover deadline and
   replacement are unrepresentable-when-absent for compulsory removals.

10. **Migrate one consumer per commit/PR, with test parity.** Follow the
    repository's existing branch workflow, keeping each consumer's tests
    green against the new surface. For on-chain or financial cutovers use the
    strangler pattern: stand the new path up alongside the old, shift liquidity
    or traffic in staged increments with reconciliation between each step, or
    ship an adapter that wraps the old ABI so callers move without a flag day.

11. **Remove only behind a verify-zero-usage gate.** The old surface comes out
    only when:
    - `cargo build` is clean with the deprecated item deleted (no remaining call
      sites),
    - `rg`/`git grep` shows zero references in every dependent repo,
    - on-chain events/state show zero traffic and zero residual position.

    Then delete the code, its tests, its docs, and the deprecation notice
    together in one commit — leaving the notice behind is its own form of rot.

## Common rationalizations

| Excuse | Reality |
|--------|---------|
| "Nobody depends on that revert message / event ordering." | Hyrum's Law: if it is observable on-chain, an integrator already parses it. It is part of the contract whether you documented it or not. |
| "It is an internal crate, it does not need a stable contract." | Internal consumers are consumers. A pinned boundary is what lets two agents work the two sides in parallel without coupling. |
| "We will bump the version when we actually break something." | A `pub` field removal or storage-slot retype IS the break. Run `cargo semver-checks` and find out before consumers do. |
| "Just reorder the storage to make the new field fit." | Reordering a deployed slot corrupts every existing value behind the proxy. Append only — there is no undo on-chain. |
| "Deprecate it now, build the replacement later." | No-advisory-forever, no replacement-later. You own it, you migrate it (the Churn Rule). A deprecation without a live replacement is just rot with a label. |
| "Leave the old function for safety, it still works." | Unmaintained live code is attack surface and audit cost — doubly so for financial/onchain code holding value. If it is needed later it can be rebuilt from git history. |
| "We can run both ABIs indefinitely." | Two live surfaces double the test matrix, the audit scope, and the reconciliation burden. Pick the One-Version Rule and finish the cutover. |

## Red flags

- A `pub` field/variant or `external` signature changed type or vanished with no
  major-version bump and no ADR.
- Storage slots reordered, retyped, or removed in a contract that is (or will be)
  behind a proxy.
- A new `enum`/`struct` exposed publicly without `#[non_exhaustive]`.
- A breaking change merged without `cargo semver-checks` output or an ADR
  justifying it.
- `#[deprecated]` added with no `note`, no replacement, and no cutover date.
- A `bool` flag named `deprecated`/`legacy`/`use_new` standing in for a
  migration policy.
- Removal commit lands while `rg` still finds call sites, `cargo build` still
  warns, or on-chain traffic is still nonzero.
- A long-running "soft" deprecation with no consumer migrated in weeks.
- New features bolted onto the surface that is supposedly being retired.
- A financial/on-chain cutover with no parallel run and no state reconciliation
  step.

## Hard rules

- **Never change a deployed Solidity `external` signature, and never reorder or
  retype an existing storage slot.** Append only.
- **Never remove or retype a `pub` field/variant without a major version bump and
  an ADR** at `adrs/NN-name.md`.
- **No breaking change ships without `cargo semver-checks` passing, or an ADR
  that explicitly justifies the break.**
- **Never deprecate without a production-proven replacement** (Churn Rule: you
  own it, you migrate it).
- **No advisory-forever.** A compulsory deprecation carries a cutover date in the
  type; an advisory one still has an owner and a finish line.
- **Parallel-run plus state reconciliation before any financial or on-chain
  cutover.** No flag-day swap of code that holds value or liquidity.
- **Removal is one commit:** code, tests, docs, and the deprecation notice all
  deleted together, only after the verify-zero-usage gate is green.

## Failure modes

- **Silent ABI break:** changed return packing or event indexing; the type
  "looks the same" but integrators decode garbage. Caught by step 3 + `forge
  inspect abi` diff, never by happy-path tests.
- **Storage collision behind a proxy:** an inserted or reordered slot overlays
  live balances. Irreversible. Caught by `forge inspect storageLayout` diff
  before deploy.
- **Diamond dependency:** two live versions of a crate force a consumer to pick;
  `Cargo.lock` shows the duplicate. Resolve via the One-Version Rule, not a
  feature flag.
- **Stranded liquidity / state:** old contract removed or frozen while it still
  holds a position. The reconciliation step in the strangler migration exists to
  prevent exactly this.
- **Zombie deprecation:** `#[deprecated]` shipped, replacement never finished,
  call sites multiply. The ADR + Churn Rule + no-advisory-forever exist to stop
  this.

## Verification

"Seems backward compatible" is never acceptable. Show the evidence:

- **Rust additive change:** `cargo semver-checks` reports no breaking changes (or
  the ADR is linked); `cargo public-api` diff shows only additions; the
  contract-first failing test now passes.
- **Rust breaking change:** the major bump is in `Cargo.toml`, the ADR exists,
  and `cargo build` across the workspace is clean.
- **Solidity:** `forge inspect <C> storageLayout` diff shows existing slots
  unchanged (additions only at the tail); `forge inspect <C> abi` diff shows no
  mutated selectors; `forge test` green.
- **Mid-migration:** every migrated consumer is a green commit with test parity;
  `rg`/`git grep` shows the remaining count shrinking per PR.
- **Removal:** `cargo build` clean with the item gone, `rg` returns zero
  references in all dependent repos, on-chain traffic/state for the surface reads
  zero — and only then the single delete commit lands.
