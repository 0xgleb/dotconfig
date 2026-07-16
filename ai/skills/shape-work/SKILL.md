---
name: shape-work
user-invocable: true
allowed-tools:
  - Read
  - Grep
  - Glob
  - "Bash(ls adrs *)"
  - "Bash(linear issue view *)"
  - "Bash(gh issue view *)"
  - Write
  - Edit
description: >-
  Use when an idea or issue is vague and needs shaping before a plan, ADR, or
  multi-file Rust, nix, or Solidity change: triggers on "shape this idea",
  "explore the design space", "stress-test this direction", "lock intent",
  "interview me", or starting a Linear or GitHub issue with unclear
  requirements. Locks intent into testable success criteria and explicit
  non-goals; it does not plan or write code.
---

Shape vague work into testable success criteria and explicit non-goals BEFORE
any plan, ADR, or multi-file change. This is the gate that stands between "an
idea" and "a plan". It interviews, diverges, converges, and locks intent — it
never plans the implementation and never writes production code.

## Core process

1. **GROUND.** Read before writing a single word. Pull the tracker item first:
   `linear issue view <ID>` for st0x / rainlanguage, `gh issue view <N>`
   elsewhere. Then read the relevant source modules, `ls adrs/` and the
   matching `adrs/NN-*.md`, and `ROADMAP.md`. You cannot shape work you have
   not read. If the idea touches a crate you have not opened, open it (Grep /
   Glob / Read) before reframing it.

2. **DIVERGE (optional, when the framing itself is in doubt).** Reframe as a
   How-Might-We that names *who it serves in domain terms* ("How might we let
   the settlement engine reject an underfunded order before it touches the
   ledger?" — not "How might we add validation?"). Generate 5-8 variations
   through lenses tuned to this engineer:
   - **inversion** — what if the invariant held by construction instead of by
     check?
   - **constraint removal** — drop a self-imposed limit and see what collapses.
   - **simplification** — the smallest thing that could possibly work.
   - **push-it-into-the-type-system** — make the bad state a compile error.
   - **move-the-check-to-compile-time** — from runtime assert to trait bound /
     const / typestate.
   - **model-as-discriminated-union** — replace a bool or a stringly-typed flag
     with an enum that makes invalid states unrepresentable.
   Keep them considered, not shallow: 5-8 real options beat 20 throwaways.

3. **LOCK INTENT (interview).** State a one-line hypothesis of what they want
   plus a confidence level (and, below ~70%, one line on what is missing). Then
   ask **ONE question at a time**, each carrying your current best guess so the
   engineer reacts to a concrete wrong guess instead of generating from scratch:

   ```
   Q: Should an underfunded order be rejected at the API boundary or at ledger commit?
   GUESS: at the API boundary, so the ledger only ever sees fundable orders.
   ```

   Reacting to a wrong guess is faster than answering an open prompt. Probe
   **want vs. should-want**: when an answer leans on "best practice", "make it
   generic", "for future flexibility", or "we might need it later", flag the
   over-engineering tell against their YAGNI style and ask: "if you did not have
   to justify it to anyone, what would you actually want here?"

4. **SURFACE ASSUMPTIONS.** Emit an `ASSUMPTIONS` block and STOP for
   correction. It must cover at least:
   - **crate / module boundaries** — where does this live, what does it depend
     on, what depends on it.
   - **on-chain vs off-chain split** — what runs in a contract vs a service.
   - **units / decimals** — token decimals, wei/gwei, basis points, cents vs
     dollars, fixed-point scale.
   - **error shapes** — `Result<_, E>` variants, revert reasons, how failure is
     represented.
   - **nix target** — darwwwin (aarch64-darwin) vs nixxxos (x86_64-linux), if
     relevant.

   ```
   ASSUMPTIONS (correct any that are wrong before I continue):
   - Lives in `crates/settlement`, called by the order intake service.
   - Off-chain check; the contract stays the source of truth on commit.
   - Amounts are u256 base units at the token's own decimals (no rescaling here).
   - Failure is a typed `RejectReason` enum, not a bool / Option.
   - No nix target impact.
   ```

5. **CONVERGE.** Cluster the surviving options into 2-3 distinct directions.
   Stress-test each against:
   - **domain value** — does it serve the actual capability, or an
     implementation detail?
   - **money-safety / invariants** — can it lose, double-count, or mis-scale
     funds? What invariant must hold?
   - **external-contract assumptions** — units, encoding, field presence, error
     shapes of anything we do not own (an ABI, an RPC response, a bridge
     message). Treat each as a guess until pinned.
   - **feasibility** — can it actually be built with the tools and time?
   - **coupling** — does it couple things that vary independently, or split
     things that always change together?

6. **VALIDATE.** For every surviving assumption, state *how* it gets validated
   in this engineer's terms — never a vague "we should check":
   - a **failing test** (type-driven TDD: the test that compiles and fails),
   - a **spike** (a throwaway branch to learn one thing, then deleted),
   - a **forge / testnet run** (`forge test`, `forge inspect`, a fork test),
   - or **reading the actual contract / ABI / protocol doc** and citing it.

7. **OUTPUT.** Reframe the ask into:
   - **Testable success criteria, phrased as the first failing test** — "the
     order intake rejects an order whose total exceeds available balance with
     `RejectReason::Underfunded`" — concrete enough to drop straight into a
     `#[test]` or a `forge` test.
   - An explicit **Non-goals / Out-of-scope** list.
   Then route it:
   - **architectural decision** → draft `adrs/NN-name.md` (next free `NN` from
     `ls adrs/`) and **STOP for review** before proceeding.
   - **roadmap-level** → an epic-based entry (goal-first prose, then checkboxes;
     never numbered "Phase 1/2"; mermaid graph when streams run in parallel).
   - **otherwise** → fold the criteria + non-goals into the Linear / GitHub
     issue body.

8. **HAND OFF.** Pass the confirmed intent to the plan stage and to type-driven
   TDD. This skill stops here. It does not plan the steps and it does not write
   implementation code.

## Common rationalizations

| Excuse | Reality |
| --- | --- |
| "The ask is clear enough to start coding." | If you cannot write the first failing test in one line right now, it is not clear — run the interview. |
| "Asking questions is slower than just building it." | Post-merge rework on the wrong abstraction costs far more than 4-6 guess-carrying questions. A wrong type that reaches `crates/` propagates everywhere. |
| "Let me make it generic so it is future-proof." | That is a want-vs-should-want tell. YAGNI: shape for the capability you have evidence for; a discriminated union you can extend beats a generic you cannot delete. |
| "I will figure out the units / decimals while implementing." | Decimals and encoding are exactly where money bugs hide. Pin them in the ASSUMPTIONS block before a line of code, not in a hotfix. |
| "I will write the spec after I get it working." | A spec written after the code just describes the code's accidents. Success criteria must exist as a failing test first, or they are not criteria. |
| "It's a small reversible change, skip the ceremony." | Then skip the skill — shaping is for the irreversible or multi-file calls. Do not write a one-pager for a rename. |
| "They said 'whatever you think.'" | That is not a yes. Offer two concrete directions as a choice; never let delegation substitute for locked intent. |

## Red flags

- Reframing or generating options before reading the issue, the source, `adrs/`,
  and `ROADMAP.md`.
- Several questions in one message (that is surveying, not interviewing).
- A question that carries no guess (you are extracting work from them, not
  committing a testable prediction).
- Confidence stated below ~70% with no one-line reason for the gap.
- Proceeding past the ASSUMPTIONS block without an explicit correction or yes.
- No Non-goals / Out-of-scope list in the output.
- A surviving assumption with no concrete validation (test / spike / forge run /
  cited doc) attached.
- Success criteria written as prose intentions ("handle errors gracefully")
  instead of a failing test you could paste into the suite.
- An external boundary (ABI, RPC, bridge message, SDK return) whose units /
  encoding / field presence is assumed but never cited or pinned to a test.
- Drafting an ADR and then continuing to plan instead of STOPPING for review.
- A roadmap entry with numbered "Phase 1 / Phase 2" headings.
- Producing the spec after the code already exists.

## Hard rules

1. **Gated on an explicit yes.** Reject "whatever you think", "sounds good", and
   silence as terminal. Loop the restatement until you get an unambiguous yes.
2. **Never fabricate CLI flags or values.** Run `--help` or read the config /
   source first. If you are unsure of a `cargo`, `forge`, `nix`, `gt`, `but`,
   `linear`, or `gh` flag, say "see `--help`" — never invent one.
3. **Not done without non-goals.** Every output carries an explicit
   Non-goals / Out-of-scope list.
4. **Not done without per-assumption validation.** Every surviving assumption
   names how it gets validated (failing test / spike / forge or testnet run /
   cited contract doc).
5. **Emit a real artifact, not a generic one-pager.** An ADR at `adrs/NN-name.md`
   (then STOP for review) OR an epic-based roadmap entry (never numbered phases;
   mermaid for parallel streams) OR locked criteria folded into the tracker
   issue. The shape matches the decision.
6. **This skill never plans and never codes.** Hand confirmed intent to the plan
   stage and type-driven TDD. If you catch yourself writing implementation steps
   or production code, stop — that is the next stage's job.

## Failure modes

- **Surveying.** Firing several questions at once, or asking any question that
  carries no guess. The discipline is one guess-carrying question at a time.
- **Yes-machine.** Treating the engineer's first phrasing as gospel and
  affirming it. Your job is to stress-test against money-safety, coupling, and
  external-contract assumptions — push back with specificity.
- **Spec-after-code.** Producing success criteria once the implementation
  already exists. The criteria must precede the code as a failing test.
- **Over-shaping the trivial.** Writing an ASSUMPTIONS block and an ADR for a
  small, reversible choice (a rename, a one-line config tweak). Shaping is for
  the irreversible or multi-file work; skip it otherwise.
- **Confidence theatre.** Stating a confidence number with no reasoning, or
  grinding three-plus rounds with flat confidence instead of flagging that the
  foundational ask itself is malformed.

## Verification

The work is shaped only when ALL of these are concretely true (not "seems
shaped"):

- [ ] The tracker issue, the relevant source, `adrs/`, and `ROADMAP.md` were
      read before any reframing.
- [ ] A one-line hypothesis with a confidence level was stated (sub-70% carries
      a reason).
- [ ] Questions were asked one at a time, each carrying a concrete guess.
- [ ] At least one want-vs-should-want probe was deployed where an
      over-engineering tell appeared.
- [ ] An ASSUMPTIONS block (crate/module boundaries, on-chain vs off-chain,
      units/decimals, error shapes, nix target) was emitted and corrected.
- [ ] Surviving directions were stress-tested against domain value,
      money-safety/invariants, external-contract assumptions, feasibility, and
      coupling.
- [ ] Every surviving assumption names a concrete validation (failing test /
      spike / forge or testnet run / cited contract doc).
- [ ] Output includes testable success criteria phrased as the first failing
      test AND an explicit Non-goals / Out-of-scope list.
- [ ] The right artifact exists: `adrs/NN-name.md` (STOPPED for review) OR an
      epic-based roadmap entry OR criteria folded into the issue — never a
      generic one-pager, never numbered phases.
- [ ] The engineer gave an explicit yes; intent was handed to the plan stage,
      not implemented here.
