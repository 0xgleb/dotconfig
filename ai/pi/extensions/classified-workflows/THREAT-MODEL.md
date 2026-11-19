# Classified action decision threat model

## Trust boundaries and assets

The classifier completion crosses from untrusted model output into the typed
action decision. A model-authored tool call then crosses from the session into
an external action. The protected assets are the owner's authority, factual
integrity, confidentiality, and truthful delivery reporting.

## Decision handling

- **Spoofing/elevation:** human intent and loaded policy remain the authority
  inputs. Only an `allow` decision executes an action.
- **Tampering:** a `remediate` decision interrupts the attempted action and
  returns the missing verification to the caller. A subsequent attempt must
  satisfy the applicable gates using current evidence.
- **Repudiation:** classifier interruptions are returned as tool-call results;
  they do not establish that the requested external action occurred.
- **Information disclosure:** deterministic protected-path and sensitive-result
  guards remain applicable to verification and subsequent attempts.

## Required regressions

- Valid classifier decisions decode into their distinct verdicts.
- Both `remediate` and `block` interrupt the action rather than execute it.
- An `allow` decision leaves the action available for execution.

## Blocker diagnostic provenance

Todo status and blocker reasons cross into classifier context as diagnostic
state, not human instructions. The assets are retained owner authority,
repository preservation, and the ability to resume authorized work.

- **Denial of service:** a recorded refusal must not become a permanent new
  prohibition. Re-evaluate the exact operation using original authority and
  current prerequisite evidence; retain any genuinely unmet gate.
- **Spoofing/elevation:** an agent clearing a status or claiming recovery cannot
  create authority, override an owner pause, or prove preservation. A successful
  preservation step does not authorize a different operation.
- **Tampering/repudiation:** preserve the original constraints and diagnostic
  record; do not clear history to manufacture permission.
- **Disclosure:** no new data source, protected-path access, or external effect
  is introduced by this clarification.

Prompt-contract regressions verify these distinctions are supplied to the
classifier and retain negative human constraints. They do not prove a model's
semantic verdict; live acceptance still requires exact current-state evidence.
