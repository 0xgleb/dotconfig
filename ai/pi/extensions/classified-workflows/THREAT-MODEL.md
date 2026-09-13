# Classified action remediation threat model

## Trust boundaries and assets

The classifier completion crosses from untrusted model output into the typed
action decision. A model-authored tool call then crosses from the session into
an external Telegram delivery. The protected assets are the owner's authority,
the factual integrity and confidentiality of stakeholder updates, delivery
audit truth, exactly-once delivery after verification, and session liveness.

## STRIDE analysis

- **Spoofing:** a model cannot create delivery authority. Human intent and
  loaded policy remain the authority inputs; a remediation decision grants no
  permission to execute the tool.
- **Tampering:** disputed or insufficiently verified claims must not be sent.
  The classifier can require verification and correction before the same action
  is retried.
- **Repudiation:** pending verification is persisted as typed session state and
  cleared only after the matching tool completes successfully.
- **Information disclosure:** deterministic protected-path and sensitive-result
  guards run unchanged. Remediation never bypasses them or exposes withheld
  content.
- **Denial of service:** missing verification cannot become a terminal
  classifier veto. A bounded continuation keeps the action pending and requires
  verify, correct, and retry or an exact blocker report.
- **Elevation of privilege:** only an `allow` decision executes an action.
  `remediate` preserves the requested outcome without executing the external
  side effect, and `block` remains terminal for absent authority or a hard
  policy violation.

## Required regressions

- A valid classifier `remediate` response parses as remediation rather than a
  generic block or an allow.
- An explicitly requested Telegram delivery with unverified claims produces a
  verification continuation, not a terminal veto.
- Pending remediation survives session reconstruction and cannot settle while
  the requested action remains unfinished.
- Only a successful result for the matching tool clears pending remediation;
  failures and unrelated tools do not.
- Hard policy blocks remain blocks, and remediation never executes the tool.

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
