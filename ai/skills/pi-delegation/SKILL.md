---
name: pi-delegation
description: Delegate work through Pi workflows, visible Zellij workers, or a bounded GPT-5.6 Sol reviewer from Claude Code. Use for subagents, parallel investigation, independent verification, or multi-agent synthesis.
---

# Pi delegation

Use the least powerful delegation mode that reliably fits the task. An explicit
user choice always wins.

## Choose a mode

Work directly when one agent can complete the task without meaningful independent
investigation.

Use Zellij workers when:

- there are only a few independent tasks;
- each worker can return a direct textual result;
- no dependency graph, retry loop, shared budget, or automatic synthesis is needed;
- visible panes are useful to the user.

Use a classified dynamic workflow when:

- tasks depend on earlier results;
- the work needs fan-out followed by verification or synthesis;
- competing approaches should be generated and judged;
- bounded loops, retries, checkpoints, or cancellation are useful;
- a task-specific program describes the desired behavior better than a fixed schema.

Never use tmux.

Independent delegation must not block the human foreground. If the parent does
not need a result before it can continue useful work, start the classified
workflow with `background: true` (or use an isolated visible worker), return
control immediately, and keep processing human prompts. Await a foreground
workflow only when its result is a genuine dependency of the very next parent
action.

## Claude Code and other non-Pi harnesses

When the current harness does not expose Pi's `workflow` tool and the user asks
for an independent GPT-5.6 Sol check, run `pi-sol-review` from the repository
being reviewed. Pass one focused, self-contained task as arguments or stdin. The
wrapper launches authenticated `openai-codex/gpt-5.6-sol` with the managed Pi
classifier and only `read`, `grep`, `find`, and `ls`; it has no write or shell
tools and does not depend on agent-registry integration.

Use this lane to challenge an idea, inspect code, or review evidence before the
human's own review. It does not attest that the human authorized a mutation and
its output remains an agent claim until checked against source. If the command
is unavailable, report that the dotconfig generation needs activation rather
than replacing it with an unclassified `codex exec`, a writable tool set, or an
Anthropic API call.

## Shared safety

- Give every worker a self-contained task, scope, expected result, and stopping
  condition.
- Never access, search, list, expose, or return credential or secret-bearing files.
- Broad searches must explicitly exclude credential-shaped paths.
- Start parallel investigation read-only.
- Never allow parallel agents to modify the same working tree.
- Keep workers in the session's assigned checkout whenever mutation isolation is
  unnecessary; do not inspect, enter, modify, build in, or create unrelated
  worktrees as routine delegation setup.
- When parallel mutation genuinely requires a worktree, use only a stable
  repository-local role slot such as `.worktrees/secondary`,
  `.worktrees/tertiary`, `.tmp/worktrees/secondary`, or
  `.tmp/worktrees/tertiary`. Never create PR-, ticket-, branch-, timestamp-, or
  task-named worktree directories.
- A disposable one-off worktree is an exceptional temporary resource. Put it
  under `.tmp/worktrees/<role-slot>`, record its exact provenance, and make the
  clanker or agent that created it remove the Git worktree registration, its
  generated outputs, and the directory immediately after success, failure, or
  cancellation. If cleanup cannot safely finish, persist the exact path and
  blocker and make cleanup the first resumed action. Never transfer this disk
  debt silently to the owner or another agent.
- A pre-existing owner-managed role slot may be reused and retained. A worktree
  created by the current clanker or agent must be removed before completion
  unless the owner explicitly asks to keep it.
- Treat classifier decisions as policy. Do not evade a block by rewording,
  obfuscating, or switching tools.
- Delegation is not a sandbox. Keep scope and capabilities minimal.
- Report failed, blocked, timed-out, or incomplete work explicitly.

## Zellij workers

Require an existing Zellij session. Do not silently create a detached session.
When the user explicitly asks to spawn an agent, focusing its new tab or pane is
allowed. For agent-initiated background delegation, snapshot the exact active tab
and pane IDs before launch and restore both before returning control. Verify the
restoration from structured Zellij state; if exact restoration is unavailable,
use a classified background workflow instead.

Create or reuse a tab named `pi-workers` under that focus contract. Start each
worker in a named pane with an
ephemeral non-interactive Pi process:

`pi --print --no-session --tools read,grep,find,ls`

Capture the pane ID returned by Zellij. Use structured pane state to determine when
the process exits and preserve its exit status. Collect the final plain-text output
with `dump-screen --full`.

Polling, harvesting, and closing background workers must preserve the user's
current focus and must never send keys to the user's active pane.

Harvest each completed pane's output and exit status promptly, then close the
pane automatically so finished workers do not linger. Keep failed panes visible
only long enough to capture diagnostics, then close them too unless the user
explicitly asks to preserve worker panes.

If a pane exits unsuccessfully or produces no usable result, mark that worker as
failed. Never infer or invent its answer.

Verify worker claims before using them in consequential edits or conclusions.
Synthesize centrally in the parent.

## Classified dynamic workflows

Write task-specific JavaScript for the `workflow` tool. The program may compose
agents, parallel work, verification, selection, checkpoints, and bounded loops. Do
not force the request into a predefined workflow template.

Every workflow must specify the smallest sufficient:

- total agent limit;
- concurrency limit;
- per-agent and whole-workflow timeouts (classified children require at least
  180 seconds per agent so spawn classification, child execution, tool-result
  classification, and return classification all fit);
- retry limit;
- total token budget.

Call agents as `agent("focused task", { cwd?, tools?, model?, thinking? })`. Pass
agent promises directly to `parallel`, for example
`await parallel([agent("first task"), agent("second task")])`. Every call must
provide a focused task, working directory when it differs from the parent, tool
capabilities, and model or thinking level when the default is not appropriate.
Prefer cheaper models for bounded discovery and stronger models for synthesis or
difficult verification. Never request `fable`, `sonnet`, `opus`, `claude-*`, or an
`anthropic/*` model from a Pi workflow child: Anthropic API billing is disabled.
When Claude adds enough value, run it only as a read-only external subscription
lane with `claude -p --permission-mode plan`. If that subscription route is
unavailable, omit Claude rather than falling back to an API provider.

Assume every agent spawn, tool action, tool result, and returned result will be
classified. Handle a blocked boundary as a typed failure. Do not expose blocked
result content to later workflow steps.

Use read-only fan-out by default. Apply edits centrally unless agents have separate
repository-approved worktrees.

For high-impact mutations, insert an explicit checkpoint. Non-interactive
checkpoints deny rather than approve automatically.

Keep workflow results compact and structured. Preserve evidence, uncertainty,
failures, and provenance needed by the synthesizer without forwarding unnecessary
conversation or tool-result content.

## Verification patterns

Prefer the smallest pattern that fits:

- fan out independent investigation, then synthesize;
- generate candidates, filter them, then verify the survivor;
- have one agent produce and another independently challenge;
- classify inputs, then dispatch only the relevant specialist;
- loop only when each iteration has a measurable stopping condition.

Do not delegate microtasks whose coordination cost exceeds their value.

## Completion

Before presenting the result:

- distinguish confirmed results from agent claims;
- verify consequential claims against source material or tests;
- identify workers that failed, timed out, or were blocked;
- state when budgets prevented complete coverage;
- preserve Zellij panes for inspection;
- never claim a workflow completed work it did not perform.
