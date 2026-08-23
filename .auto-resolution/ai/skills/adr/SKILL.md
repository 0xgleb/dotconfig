---
name: adr
description: Use to write, record, or supersede a confirmed significant or expensive-to-reverse architectural decision; if intent or alternatives are still unclear, use `shape-work` or `architect` first, and do not use this for implementation-plan or code review.
allowed-tools:
  - "Bash(ls adrs*)"
  - "Bash(git add adrs/*)"
  - "Bash(git status *)"
  - "Bash(git log *)"
  - "Bash(git diff *)"
  - "Bash(git commit *)"
  - "Read"
  - "Write"
  - "Edit"
  - "Glob"
  - "Grep"
---

# ADR

Records a significant architectural decision at `adrs/NN-name.md`, surfaces it
for review, and keeps authorized work moving on a separate commit or child branch.
The ADR remains `Proposed` until a reviewer accepts it; drafting it creates a
review point, not an implicit pause.

## When this applies

Write an ADR for decisions that are significant **and** expensive to reverse:

- Settlement / atomicity model, on-chain finality assumptions, reorg handling.
- Contract upgrade strategy (proxy vs immutable), storage layout, trust boundaries.
- A type-level invariant that shapes a whole module (how invalid states are made
  unrepresentable, which newtypes carry which guarantees).
- Nix architecture: import-from-derivation, flake input pinning strategy, purity
  tradeoffs, cross-platform (darwwwin vs nixxxos) split.
- A dependency or external-contract assumption the rest of the system will lean on.

Skip the ADR for trivial, easily reversible choices (a local helper's shape, a
test fixture name, a lint config tweak). Those belong in the code and the commit
message, not in `adrs/`.

## Core process

1. **Locate `adrs/` at the repo root** and read what is already there.
   ```bash
   ls adrs
   ```
   If the directory does not exist yet, create it by writing the first record at
   `adrs/01-name.md` (match whatever zero-padding width the team later settles on;
   default to two digits).

2. **Compute the next index** matching the existing files' zero-padded width.
   Use `Glob` for `adrs/*.md`, take the highest numeric prefix, add one, and keep
   the same width (e.g. after `07-...` comes `08-...`, not `8-...`). Never reuse or
   renumber an existing index.

3. **Confirm it is not already settled and is genuinely significant.** `Grep`
   `adrs/` for the topic before drafting — if an Accepted ADR already covers it,
   you are either following it (no new ADR) or superseding it (step 7). Reversible,
   low-blast-radius choices do not get an ADR.

4. **Scaffold the record** at `adrs/NN-name.md` using the template below. Status
   starts `Proposed`. Write the Context in domain terms — the actual constraints
   (settlement atomicity, on-chain finality, nix purity / import-from-derivation,
   the type-level invariant at stake), not generic platitudes.

5. **Link the tracker issue.** For st0x / rainlanguage work, link the Linear issue
   (see the `linear` skill). Everywhere else, link the GitHub issue. If no issue
   exists yet and the decision warrants one, say so rather than inventing a link.

6. **Surface the review point; whether to pause depends on the model.**
   Summarize the decision and rejected alternatives and point the user at
   `adrs/NN-name.md`. Then:
   - **gpt-5.6-sol and Claude Fable (`claude-fable-5`) only: optimistic
     approval.** Proceed straight into implementation on a separate commit or
     child branch without waiting. The owner reviews the ADR at PR time — open
     the PR **non-draft** so CodeRabbit reviews before the owner looks. The
     owner judged these two models reliable enough that a wrong bet rarely
     means a full rewrite; that bet is NOT extended to other models.
   - **Every other model: stop and wait.** Keep the ADR `Proposed`, do not
     start implementation in the new direction until the user explicitly
     approves. Do not infer approval from continued unrelated work.

   In both cases the ADR stays `Proposed` until a reviewer accepts it, and a
   missing decision that makes further work unsafe or ambiguous is always a
   hard pause.

7. **On reversal, write a NEW ADR.** Never edit or delete an Accepted ADR. Create
   `adrs/MM-name.md` that references the old one, then flip only the old record's
   `Status:` line to `Superseded by adrs/MM-name.md`. The historical rationale
   stays intact.

8. **Commit as a small increment** with plain git, on a branch (never straight to a
   protected master). Match the repo's commit style first.
   ```bash
   git log --oneline -10
   git add adrs/NN-name.md
   git commit -m "<message matching repo style>"
   ```
   Use `gt` only in Graphite-opted-in repos (st0x / rainlanguage); plain `git`
   everywhere else.

## ADR template

```markdown
# NN. <Short decision title>

- Status: Proposed
- Date: YYYY-MM-DD
- Issue: <Linear ID for st0x/rainlanguage, else GitHub issue link>

## Context

<The forces at play in domain terms: the invariant that must hold, the settlement
or finality constraint, the nix purity tradeoff, the type-level guarantee we need.
State the problem and the desired end state — not the diff.>

## Decision

<The approach chosen, stated plainly. What we will do.>

## Alternatives Considered

### <Alternative A>
- Pros: <...>
- Cons: <...>
- Rejected because: <the concrete reason this loses against the Decision>

### <Alternative B>
- Pros: <...>
- Cons: <...>
- Rejected because: <...>

## Consequences

<What becomes easier and what becomes harder. New constraints the codebase now
carries, follow-up work, and the blast radius if this turns out wrong.>
```

## Common rationalizations

| Excuse | Reality |
| --- | --- |
| "An ADR is overhead, I'll just build it." | A 15-minute record kills a 3-hour re-litigation of settlement model or proxy-vs-immutable months later, when no one remembers why. |
| "The types are self-documenting." | The type system encodes *what* is enforced; it cannot show which alternatives were rejected or why on-chain finality forced this shape. |
| "It's obvious, there's only one sane choice." | If it is truly obvious it takes five minutes to write and proves it; if it isn't, you just found the decision that needed an ADR. |
| "I'll write it once the design stabilizes." | The ADR is how the design stabilizes — forcing the alternatives onto paper surfaces the flaw before it ships to mainnet. |
| "Nobody reads `adrs/`." | The next agent, the auditor, and your future self do — especially when debugging why the invariant was chosen this way. |
| "I'll just edit the old ADR to match the new plan." | That destroys the historical record. Reversals get a new ADR; the old one is marked Superseded, never rewritten. |

## Red flags

- Starting implementation of an expensive-to-reverse decision with no `adrs/` entry.
- A significant settlement / finality / upgradeability / nix-purity choice landing
  with the rationale living only in a PR description or a chat message.
- Editing the body of an already-Accepted ADR instead of superseding it.
- An ADR whose Context is generic ("we need it to be scalable") instead of naming
  the actual domain constraint.
- "Alternatives Considered" with one entry, or alternatives missing a concrete
  "Rejected because".
- Numbered "Phase 1 / Phase 2" framing anywhere in the record.
- Bundling implementation into the ADR commit instead of leaving the proposed
  decision independently reviewable.

## Hard rules

1. ADRs live at `adrs/NN-name.md` at the repo root — never `docs/decisions/`,
   never anywhere else.
2. The next index is zero-padded to the existing files' width; never reuse or
   renumber.
3. Always surface the proposed ADR for review. gpt-5.6-sol and Claude Fable
   assume optimistic approval and continue into implementation (owner reviews
   at non-draft PR time, CodeRabbit first); every other model pauses for
   explicit approval before building in the new direction.
4. Never rewrite or delete an Accepted ADR. Reversals are a new ADR that references
   the old one; the old `Status:` flips to `Superseded by adrs/MM-name.md`.
5. Every alternative carries Pros, Cons, and an explicit "Rejected because".
6. No numbered "Phase" framing — describe the decision and its consequences, not a
   rollout sequence.
7. Commit on a branch with plain git (`gt` only in opted-in repos); never push to a
   protected branch without an explicit instruction.

## Failure modes

- **`adrs/` does not exist** — the repo has never recorded a decision. Create it by
  writing the first record; do not silently drop the ADR into `docs/` instead.
- **Topic already has an Accepted ADR** (caught by the Grep in step 3) — you are
  following it or superseding it, not writing a duplicate. Decide which and act.
- **Decision is actually reversible/trivial** — no ADR. Record the choice in the
  code and commit message and move on.
- **No tracker issue exists** — link nothing rather than fabricating an ID; tell the
  user an issue may be warranted.

## Verification

- `ls adrs` shows the new `adrs/NN-name.md` with the correct zero-padded index and
  no gap or collision with existing records.
- The record has every section: Status (`Proposed`), Date, Issue link, Context,
  Decision, Alternatives Considered (each with Pros / Cons / Rejected because), and
  Consequences.
- For a supersession: the new ADR references the old one, and `git diff` shows the
  old file changed on its `Status:` line only.
- The user has been shown the summary; implementation is isolated in a later
  commit or child branch. Under optimistic approval (gpt-5.6-sol / Claude
  Fable) implementation proceeds with the ADR still `Proposed`; other models
  hold until explicit approval.
- `git log --oneline -1` shows the ADR committed as its own small increment on a
  branch, not bundled into an implementation commit.
