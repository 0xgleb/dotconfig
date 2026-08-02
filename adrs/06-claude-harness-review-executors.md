# 06. Run review execution in Claude Code harness sessions

- Status: Proposed
- Date: 2026-08-02
- Issue: None (personal orchestration architecture)
- Supersedes: [ADR 05](05-dedicated-pi-agent-workspaces.md)

## Context

ADR 05 created three long-running Pi review workspaces for ST0x/rainlanguage,
DataClique, and personal `0xgleb` repositories. Those workspaces correctly
separated repository authority and added typed review, Telegram, publication, and
automatic-merge gates, but they also used GPT-5.6 Sol for periodic inventory and
full review execution. Fifteen-minute polling and repeated multi-agent review
panels consumed the weekly OpenAI subscription allowance too quickly.

The owner already pays for Claude Code and explicitly requires review execution
to use its interactive subscription harness, not Anthropic API providers reached
through Pi. The verified `f clanker --claude --new` route starts a fresh Claude
Code session with high effort, workflows, fullscreen rendering, and Auto Mode.
The shared review skills are exposed to Claude through `~/.claude/skills`, so the
review engine does not need an API adapter or a second copy of its procedures.

The typed Pi boundaries still carry value. Registry ownership, Piece of Pi
Telegram correlation, `review_duty` state, empty-body pending-review publication,
and the two exact automatic-merge lanes should not be reimplemented as prompt-only
Claude behavior. The architectural invariant is therefore to separate cheap,
mechanical supervision from expensive review reasoning. No monetary, on-chain,
credential, or remote-execution authority is added.

## Decision

Keep one narrow Pi supervisor per existing authority domain, but move every
substantive PR review and fix/re-review pass into a fresh Claude Code harness
executor:

- `st0x-review` supervises only ST0x-Technology and rainlanguage;
- `dataclique-review` supervises only DataClique repositories;
- `personal-review` supervises only `0xgleb` repositories.

The supervisors use GPT-5.6 Luna rather than Sol, poll every two hours, and perform
inventory, deduplication, typed `review_duty` transitions, Telegram handoff,
publication, and final merge-gate verification only. An empty inventory never
starts a review panel. Sol is not a recurring parent or review executor.

For each actionable PR, the supervisor launches a fresh visible Claude Code
executor in the corresponding existing Zellij review tab. Launching uses exact,
source-fixed argv equivalent to `f clanker --claude --new`: the local `claude`
CLI, subscription authentication, high effort, workflows, fullscreen TUI, Auto
Mode, no continue/resume flag, and a source-fixed review-duty prompt. It never
selects an Anthropic model through Pi, never supplies an API key, and never falls
back to Anthropic API billing.

A Claude-compatible `review-duty-claude` skill adapts the existing `review-loop`,
`review-pr`, and shared review engine to this split. The executor receives one
repository/PR/head-SHA contract, uses the repository's normal skills and worktree
rules, and returns bounded findings, fixes, validation, and terminal status to the
supervisor. Claude cannot advance Pi review-duty state, infer a user verdict,
weaken publication rules, or merge outside the two already-authorized automatic
lanes. Failure, cancellation, missing handoff evidence, or a changed head SHA
leaves the Pi gate pending and fails closed.

Every actionable executor result receives a strong independent verification
before publication or merge. Fable inside the Claude Code subscription harness is
the default verifier; authenticated GPT-5.6 Sol through the existing OpenAI
subscription is the fallback when an independent Claude verifier is unavailable.
Neither route may use an Anthropic API provider or paid API key. Verification must
re-read the cited diff/source and reject stale head SHAs, unsupported findings,
missing tests, or incomplete merge gates.

Cursor Grok 4.5 or Composer 2.5 may remain optional temporary mechanical lanes
while their included allowance exists. They are never required for completion.
Haiku or other micro-model fan-out remains out of scope.

## Alternatives Considered

### Keep the Sol-powered Pi reviewers and merely reduce polling

- Pros: No handoff work and all typed tools remain in one process.
- Cons: Full reviews still consume the scarce weekly OpenAI allowance, and empty
  or low-value turns still run through a premium model.
- Rejected because: The owner explicitly requires the already-paid Claude Code
  harness to carry review execution; cadence reduction alone does not meet that
  requirement.

### Route Claude models through Pi workflow providers

- Pros: The existing classified workflow runtime could orchestrate every lane and
  collect structured results directly.
- Cons: It incurs Anthropic API billing, violates the existing provider policy,
  and duplicates functionality already included in Claude Code.
- Rejected because: Avoiding API rates is the central requirement. Claude is
  permitted only through the local subscription harness.

### Replace every Pi process with an unconstrained long-running Claude session

- Pros: Simplest visible setup and no recurring Pi model usage.
- Cons: Claude does not own Pi's typed registry, Telegram question correlation,
  review-duty persistence, or automatic-lane state machine. Reimplementing those
  as prompt instructions would weaken mechanical gates and collapse recovery
  evidence.
- Rejected because: Review reasoning and control-plane state vary independently;
  the safe split keeps each in the system that already implements it.

### Centralize all repositories under one Pi supervisor

- Pros: Fewer processes and one periodic inventory.
- Cons: Mixes ST0x, DataClique, and personal authority, increases incident blast
  radius, and makes repository-specific automatic-merge policy less auditable.
- Rejected because: The owner previously required three isolated authority
  domains, and changing the executor does not justify collapsing them.

## Consequences

Review reasoning and fix execution consume the Claude Code subscription instead
of Anthropic API charges or most of the weekly Pi allowance. Periodic Pi work is
bounded to Luna-powered two-hour inventory and typed coordination. Fresh Claude
sessions reduce stale cross-PR and cross-owner context, while shared skills remain
the single review-procedure source. Mandatory Fable-or-Sol verification preserves
a strong independent check before anything is published or merged.

The system gains an explicit handoff boundary. It must verify repository, PR,
head SHA, authorship lane, executor identity, result status, and referenced
artifacts before advancing review duty. A supervisor or executor crash can leave a
job pending but cannot silently complete it. Operators must be able to restart a
fresh executor without duplicating publication or merge mutations.

The existing review tabs now contain a narrow Pi supervisor and a visible Claude
executor rather than a Sol-powered Pi review process doing both jobs. Adding a new
authority domain still requires a reviewed source-fixed profile and skill contract.
The two-hour cadence is a current usage policy and may be changed independently
without revisiting the harness split.
