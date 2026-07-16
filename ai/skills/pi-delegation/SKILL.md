---
name: pi-delegation
description: Delegate Pi work through visible Zellij workers or classified dynamic workflows. Use when the user requests subagents, delegation, parallel investigation, Ultracode-style workflows, independent verification, or multi-agent synthesis.
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

## Shared safety

- Give every worker a self-contained task, scope, expected result, and stopping
  condition.
- Never access, search, list, expose, or return credential or secret-bearing files.
- Broad searches must explicitly exclude credential-shaped paths.
- Start parallel investigation read-only.
- Never allow parallel agents to modify the same working tree.
- Use the repository-approved worktree mechanism for parallel mutations.
- Treat classifier decisions as policy. Do not evade a block by rewording,
  obfuscating, or switching tools.
- Delegation is not a sandbox. Keep scope and capabilities minimal.
- Report failed, blocked, timed-out, or incomplete work explicitly.

## Zellij workers

Require an existing Zellij session. Do not silently create a detached session.

Create or reuse a tab named `pi-workers`. Start each worker in a named pane with an
ephemeral non-interactive Pi process:

`pi --print --no-session --tools read,grep,find,ls`

Capture the pane ID returned by Zellij. Use structured pane state to determine when
the process exits and preserve its exit status. Collect the final plain-text output
with `dump-screen --full`.

Keep completed panes visible so the user can inspect or close them normally.

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
- per-agent and whole-workflow timeouts;
- retry limit;
- total token budget.

Every `agent` call must provide a focused prompt, working directory when it differs
from the parent, tool capabilities, and model or thinking level when the default is
not appropriate. Prefer cheaper models for bounded discovery and stronger models
for synthesis or difficult verification.

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
