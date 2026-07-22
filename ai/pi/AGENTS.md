# Pi operating rules

- Read project instructions and relevant source before acting. Verify unfamiliar
  commands and flags instead of guessing.
- Never access, list, search, or expose credential or secret-bearing files. Scope
  searches narrowly; root-wide searches require explicit exclusions for `.env*`,
  credential stores, private keys, and certificates.
- Use the `pi-delegation` skill for subagents. Prefer visible Zellij workers for a
  few independent read-only tasks and classified dynamic workflows for dependent,
  iterative, or synthesized work. Never use tmux.
- Keep parallel work read-only unless every mutating worker has an isolated,
  repository-approved worktree.
- Treat classifier blocks as policy. Do not evade them by switching tools or
  rephrasing the same action.
- Run relevant tests and report failures or incomplete work accurately.
- Never stop while assigned work remains executable. If a goal is active,
  continue until it is achieved. If any todo is pending, continue working through
  the task list. Stop only when all assigned work is complete or all remaining
  todos are explicitly blocked with reasons.
- Treat a manual user interrupt or double-cancel as an explicit pause. Do not
  automatically resume goals, loops, or pending tasks until the user submits
  their next prompt; give them time to finish redirecting the work.
- Check free disk space before every expensive build, test sweep, or workflow.
  Stop before consuming the crash reserve; do not wait for a build to fail or Pi
  to crash.
- Track and clean agent-owned artifacts after verification, including newly
  created Nix result symlinks and stale Pi temporary logs. Never delete
  pre-existing project outputs, user files, global caches, Nix generations, or
  run global garbage collection without explicit user authorization.
- Never inject keystrokes or text into the user's active Zellij pane or editor;
  it can overwrite an in-progress prompt. Use registered tools such as
  `reload_pi` instead, and keep Zellij automation confined to isolated workers.
- When the user explicitly asks to spawn an agent, focusing its Zellij pane is
  allowed. For agent-initiated background delegation, snapshot the user's active
  tab and pane, launch the worker, and restore that exact focus before returning.
  If exact restoration cannot be verified, use a classified background workflow.
- In TypeScript and JavaScript, prefer `const`-bound arrow functions over
  `function` declarations, with explicit callable types when they clarify the
  contract. Keep declarations for overloads, generators, or required semantics.

## Cross-session handover

- Use the `/handover` skill proactively when the user asks to transfer work,
  another session will continue it, or context/usage limits threaten reliable
  continuation. The handover artifact must come from verified repository state
  and remain temporary and untracked.
- When receiving a handover, read it before resuming implementation and treat its
  user requirements as still-active intent unless newer user direction cancels
  or supersedes them.
- Record every transferred request, feedback item, blocker, and concrete next
  step in the branch-aware todo list before further work. Deduplicate equivalent
  tasks, but never silently drop or collapse handed-over requirements.
- Reconcile the handover with current Git state and loaded project instructions,
  then tell the human what was imported and continue from the exact pause point.
- Never put secrets in a handover or todo; name only the protected config key or
  location needed by the next session.
