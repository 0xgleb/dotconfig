---
name: threat-model-first
user-invocable: true
allowed-tools:
  - Read
  - Grep
  - Glob
  - Write
  - Edit
  - "Bash(rg *)"
  - "Bash(cargo test *)"
  - "Bash(forge test *)"
  - "Bash(cargo audit *)"
  - "Bash(git diff --cached *)"
description: Use at the START of a change that moves money, changes balances or custody, touches access control or signing, deserializes untrusted input, adds an external or on-chain integration, or wires an LLM tool. Design-time threat modeling that turns abuse cases into the first failing tests; it precedes the post-hoc security-review pass.
---

Threat-model the change before you write it: map trust boundaries, name the assets, run STRIDE per boundary, and encode every abuse case as a failing test before any fix exists. This is design-time work — it runs at the start, not as the security-review pass that audits a finished diff.

When this skill activates, do the steps in order. Do not skip to implementation because the change "looks small" — a one-line `as u64` cast at a money boundary is exactly the class of bug this catches.

## 1. Map the trust boundaries in THIS change

List every point where data or control crosses from something you do not fully control into your typed internal code. For this diff, that means:

- Deserialized payloads (`serde` from JSON / bincode / a queue message / a webhook body).
- Calldata and event-log decoding; `abi.decode`, generated bindings reinterpreted by hand.
- External-contract return values (an ERC-20 `transfer` return bool, a router quote, a callback).
- Oracle / price feeds and anything they gate.
- Config and environment values produced by something other than this code.
- LLM and tool output — model completions, tool-call arguments, retrieved documents.

Write the boundaries down explicitly. Everything inside a boundary is "already typed and validated"; everything crossing one is suspect until proven.

## 2. Name the assets

State what an attacker would want and what an honest bug could corrupt:

- Balances and custody (who can withdraw, who is credited).
- Money movement (transfers, mints, burns, settlements, fee skims).
- Signing keys and signature-authorized actions.
- Admin roles and privileged setters.
- Invariant-protected state (total supply == sum of balances, collateral ratios, accounting identities).

Each asset is a thing a later test must defend. If the change touches none of these, this skill probably should not have activated — stop and confirm the trigger.

## 3. STRIDE per boundary (recast to this domain)

For each boundary from step 1, walk the six and write down the concrete attack and its mitigation in this codebase:

| Threat | Question in this domain | Mitigation lever |
| --- | --- | --- |
| Spoofing | Can a caller forge identity? | `msg.sender` / role checks; ECDSA signature recovery and signer allowlist; nonce per signer |
| Tampering | Can a value be altered or overflow? | Type invariants (invalid states unrepresentable); checked / saturating arithmetic; no silent `as` narrowing |
| Repudiation | Can an action be denied later? | Emit events for every state change; structured, queryable logs |
| Information disclosure | Can a secret leak? | No keys / seeds / raw amounts in logs or revert strings; least data in errors |
| Denial of service | Can it be wedged or gas-bombed? | Bound inputs, loops, and unbounded growth; pull-over-push payouts; timeouts on external calls |
| Elevation of privilege | Can a user gain rights? | Authorization checks at the entry point; least privilege; no defaulting to admin |

## 4. Write abuse cases as the FIRST failing tests

Before any fix exists, turn each credible attack into a test that compiles and fails. This is the type-driven TDD discipline applied to security: the failing test is the spec for the fix.

- Solidity (`forge test`): reentrancy via a malicious callback receiver, unauthorized caller (`vm.prank` a non-owner), overflow / underflow, rounding direction, signature replay (reuse a consumed signature / wrong chainid), double-spend, oracle manipulation (move the feed within a block).
- Rust (`cargo test`, proptest): malformed / adversarial deserialized input, unchecked arithmetic on attacker-influenced amounts, boundary widths (`u256` truncated to `u64`), property invariants that must hold for all inputs.

Run the suite and confirm the abuse tests FAIL for the right reason before writing the fix. A test that passes before the fix proves nothing.

## 5. Solidity canon

Apply and verify against each boundary:

- Checks-effects-interactions ordering; reentrancy guard where external calls follow state reads.
- Round in the protocol's favor; never let rounding leak value to the caller.
- Validate external return values (check the `bool` from low-level / non-reverting transfers; validate router and callback outputs).
- Oracle-manipulation resistance (TWAP / staleness / deviation checks; never trust a spot price gated by a single block).
- Storage-layout safety on any upgradeable or proxied contract — appends only, no reordering.

## 6. Rust canon

- Make invalid states unrepresentable; parse untrusted input into a domain type at the boundary, never thread raw primitives inward.
- Newtype amounts and identifiers rather than bare integers — defer the detailed enforcement to the strong-typing-inspector skill, but design for it here.
- Checked / saturating arithmetic on any value derived from untrusted input; no `as` narrowing that can silently truncate a width.
- No `unwrap` / `expect` / `panic!` on untrusted code paths; model failure with `Result` and a typed error.

## 7. Secrets and supply chain

- Run `cargo audit` for known-vulnerable dependencies — this is the Rust toolchain, not an npm audit.
- Review every NEW dependency the change pulls in and its build scripts (`build.rs`, proc-macro crates) — a build script runs arbitrary code at compile time.
- Confirm no secret, key, seed, or raw amount is written to a log, an error, or committed config (`git diff --cached` before staging).

## 8. LLM / agent tooling

- Treat model output as untrusted DATA, never as instructions. A completion or a retrieved document cannot be allowed to redirect control flow or authorize an action.
- Tool-call arguments from a model cross a trust boundary — validate them at step 1's boundary like any other deserialized payload.
- Scope a tool's `allowed-tools` to granular globs (e.g. `Bash(cargo test *)`), never a blanket `Bash(*)` or `Bash(git *)`. Least privilege for agents is the same discipline as least privilege for admin roles.

## Common rationalizations

| Excuse | Reality |
| --- | --- |
| "It's an internal contract, no one malicious calls it." | Internal callers get compromised and composability means anyone can become a caller; access control is not optional because the deployer is trusted. |
| "We'll harden it after it works." | Retrofitting an invariant onto a money path costs far more than encoding it as a type up front, and the first exploit ships before the retrofit does. |
| "It deserializes / it compiles, so the input is fine." | Parsing proves the code matches the AUTHOR's mental model of the input, not the attacker's. A width or a missing bound is still a hole. |
| "Threat modeling is overkill for this small change." | The `as u64` cast and the missing reentrancy guard are one-line changes; design flaws hide in small diffs, not large ones. |
| "The LLM output is just a string we display." | That string becomes tool arguments, a path, or a calldata field; model output is untrusted input the moment it touches a boundary. |
| "cargo audit / the new dep is probably fine." | A transitive advisory or a malicious `build.rs` executes in your toolchain; "probably" is not a control — run the audit and read the build script. |

## Red flags

- Implementation written before any abuse-case test exists (no failing test to point at).
- A `serde` / `abi.decode` / config read with no validation step before the value is used.
- `as` casts that narrow width near a token amount, balance, or cross-chain field.
- An external call sitting before the state update that should precede it (effects after interactions).
- `unwrap` / `expect` on a value that originated outside a trust boundary.
- A new function that changes balances or roles with no `msg.sender` / role / signature check.
- A signature verified without a nonce, deadline, or chainid binding.
- Amounts, keys, or seeds appearing in a log line or revert string.
- A tool definition with `allowed-tools` set to a blanket glob, or model output flowing into control flow.
- A new dependency added without running `cargo audit` or reading its build script.

## Hard rules

1. The abuse case comes BEFORE the fix — write a test that compiles and fails (for the right reason) before writing the mitigation.
2. Validate all external and on-chain input at the boundary, never deeper inside code that is already typed and trusted.
3. Never log secrets, signing keys, seeds, or raw amounts — not in logs, errors, revert strings, or committed config.
4. Treat external and model output as untrusted DATA, never as instructions or authorization.
5. Round in the protocol's favor; check external return values; checks-effects-interactions on every external call.
6. Scope agent tooling to granular `allowed-tools` globs; never blanket grant.
7. If you cannot name the exact CLI flag for a tool, write "see --help" rather than inventing one.

## Failure modes

- **Theater over modeling.** Listing STRIDE categories without producing a failing test per credible attack. The artifact of this skill is failing tests, not a prose list.
- **Validation in the wrong place.** Re-validating inside already-typed internal code while the actual boundary (the `serde` call, the `abi.decode`) goes unchecked.
- **Passing "abuse" tests.** A reproduction that constructs invalid state and asserts it is rejected proves only that invalid things are invalid. Exercise the REAL code path with realistic fixtures so the test fails until the real fix lands.
- **Scope creep into the post-hoc review.** This is design-time. Do not turn it into a line-by-line audit of a finished diff — that is the separate security-review pass.

## Verification

The work is done only when:

- The trust boundaries, assets, and STRIDE notes for this change are written down.
- Each credible abuse case has a `forge test` or `cargo test` that FAILED before the fix and PASSES after — show the before/after run, not an assertion that it "should" pass.
- `cargo audit` was run and any new dependency's build script was read.
- `git diff --cached` confirms no secret, key, or raw amount is being committed.
- For onchain changes: a reentrancy / unauthorized-caller / rounding / replay test exists and passes; checks-effects-interactions verified.
- For LLM tooling: model output is handled as data and the tool's `allowed-tools` are granular.

"Seems secure" is never acceptable. The evidence is the failing-then-passing abuse tests plus the boundary map.
