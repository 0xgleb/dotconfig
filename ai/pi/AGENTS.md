# Pi operating rules

- Read project instructions and relevant source before acting. Verify unfamiliar
  commands and flags instead of guessing.
- Do not mirror the user's latest framing or agree reflexively. Before affirming a
  claim, name the evidence and test the strongest plausible counter-hypothesis.
  Treat rewording as no new evidence, do not oscillate conclusions without changed
  facts, inspect existing code and docs before proposing additions, and explicitly
  correct prior unsupported answers.
- Never access, list, search, or expose credential or secret-bearing files. Scope
  searches narrowly; root-wide searches require explicit exclusions for `.env*`,
  credential stores, private keys, and certificates.
- Use the `pi-delegation` skill for subagents. Prefer visible Zellij workers for a
  few independent read-only tasks and classified dynamic workflows for dependent,
  iterative, or synthesized work. Never use tmux.
- Any Pi host, extension, TUI, auto-classifier, delegation, reload, or operator
  bug encountered outside `~/.config` requires the agent to check `agent_registry`
  and delegate it immediately to project `/Users/0xgleb/.config`, role `pi-support`.
  Queue the request without self-claiming that dedicated role when its operator is
  temporarily absent. Continue the primary project task without duplicating the
  support fix unless that bug blocks it. For other cross-project support, delegate
  to the live role owner; if the role is unowned, claim it temporarily and handle
  it locally. A role never grants authority beyond constrained project tools, and
  an operational role is not done merely because its inbox is empty. The session
  rooted at `~/code/dataclique/yielduck` owns its managed `operator` role and keeps
  monitoring even when every current implementation todo is blocked. A registry
  read/sync failure means coordination is temporarily unavailable; it does not
  revoke authorization already established by the user and project policy or
  block unrelated Git delivery. Continue safely when no exclusive lease or request
  transition is required. Never infer new authority from an unavailable registry;
  block only the operation that actually requires registry ownership.
- Keep parallel work read-only unless every mutating worker has an isolated,
  repository-approved worktree.
- Treat classifier blocks as policy. Do not evade them by switching tools or
  rephrasing the same action. A block is not permission to stop: if the blocked
  action was unrelated or over-scoped, return to the real active task through a
  safe path. Never invent `--force` or equivalent bypass flags in response.
- Run relevant tests and report failures or incomplete work accurately.
- PR reviews must never publish a top-level review body, marker, summary, verdict,
  or reviewed-commit text. Review automation may create only an empty-body
  pending review containing verified inline comments; keep the overall assessment
  in the local conversation. For ordinary body-only correction, clear only the
  top-level body and preserve every inline comment. When the user explicitly says
  the entire agent-created review was accidental and orders full cleanup, remove
  the exact evidenced agent-created review and its inline comments rather than
  preserving, replacing, dismissing, or relabeling them. Never substitute a marker,
  apology, zero-width text, or other non-empty body. If GitHub rejects deletion or
  emptying of a submitted review, retain and report the exact API error, continue
  all independently executable cleanup, and identify escalation to GitHub support;
  do not claim an untried deletion is impossible.
- Never stop while assigned work remains executable. If a goal is active,
  continue until it is achieved. If any todo is pending, continue working through
  the task list. Stop only when all assigned work is complete or all remaining
  todos are explicitly blocked with reasons.
- Treat a manual user interrupt or double-cancel as an explicit pause. Do not
  automatically resume goals, loops, or pending tasks until the user submits
  their next prompt; give them time to finish redirecting the work.
- When safe compaction preparation is requested, persist critical state, goals,
  todos, exact pause points, and unfinished actions, then call
  `safe_compaction_ready` with the exact next action. A displayed tool call with
  no successful tool result was not executed. After compaction, resume that
  action and continue all assigned work rather than treating the summary as
  completion.
- Treat the managed resource-pressure guard as the authoritative automatic
  preflight for expensive builds, test sweeps, and workflows. Do not poll `df`,
  `vm_stat`, or process lists before routine work. If the guard blocks, follow
  its bounded cleanup guidance and preserve the crash reserve rather than
  repeatedly probing or waiting for a build to fail.
- Track and clean agent-owned artifacts after verification, including newly
  created Nix result symlinks and stale Pi temporary logs. Record newly created
  project `.tmp/` files/directories immediately with `artifact_provenance` so
  later exact cleanup has durable evidence. Never delete pre-existing project outputs, user files, global caches, Nix generations, or
  run global garbage collection without explicit user authorization. Exact
  rebuildable build outputs are disposable by default, but project instructions
  and verified repository configuration may protect artifacts consumed by a
  runtime, watcher, supervisor, release, or deployment process. Inspect any
  referenced configuration before cleanup and preserve a cleanup root containing
  a configured live artifact unless disruption is explicitly requested.
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
- In TypeScript, encode expected failures in the Effect error type. Use
  `Effect.try`/`Effect.tryPromise` at genuinely throwing boundaries and recover
  through typed error handlers rather than untyped `try`/`catch` control flow.
- Treat persisted state, external responses, configuration, arithmetic, and
  cross-module inputs as capable of violating assumptions. Enforce invariants in
  types where possible and at the narrowest boundary otherwise. An invariant
  violation returns a specific typed error; it never panics, silently coerces the
  value, invents a fallback, or continues with partially trusted state. Test the
  malformed or impossible shape alongside the valid path.
- Use small custom macros or generators only for genuinely mechanical boilerplate
  when they make the invariant easier to read at every call site. Keep domain
  operations, control flow, types, and error paths visible; if an abstraction
  hides those, write the explicit code instead.

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
