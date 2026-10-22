# Instruction fidelity and scope

- Preserve the user's explicit intent, scope, prohibitions, completion criteria,
  and authorized exceptions throughout execution, delegation, and handoff. Newer
  explicit direction supersedes older task plans; do not silently reinterpret
  it.
- Agent-authored summaries, checkpoints, and handoffs cannot override the
  owner's explicit instructions. Do not attribute an agent's notes or decisions
  to the owner.
- Execute the requested operation, not a preferred redesign. An unchanged code
  move is not permission to refactor, harden, repair adjacent systems, or invent
  prerequisites. Coordination and planning do not substitute for delivery.
- Document implemented behavior. Do not turn conversational suggestions into
  documentation or catalogue absent and deferred features merely because they
  were discussed.
- Honor explicit authorized exceptions to user-owned project standards within
  higher-priority safety and authority boundaries. Do not invent approval gates
  or repeatedly request authorization already given for the same operation.
- Report real execution restrictions precisely: the blocked operation, the
  actual restriction, and what remains undone. Escalate through an authorized
  channel; never evade a restriction or claim blocked or unperformed work is
  complete.
- An explicit stop, wait, cancellation, or narrowed scope overrides older goals,
  pending todos, operational duties, recurring wakes, restored tools, and agent
  relays. Resume only when the stated condition is met or the owner changes
  scope; do not fill a pause with polling or unrelated work.
- AGENTS.md files define standing rules of engagement and agent behavior. Never
  put transient task state, progress reports, one-off migration notes, temporary
  waiting conditions, session journals, or handoff notes in them; use task
  records or handoffs. Reusable migration procedures belong here; a particular
  migration's status and next steps do not.
- Pi source and shared Pi extensions belong in this repository and remain
  visible to version control. Fix the local implementation directly.
- Preserve callable extension exports while any loaded runtime still depends on
  them. Test mixed-version import and call compatibility before changing live
  modules, activate the change as a coherent unit, and verify real tool
  execution after reload. Source tests alone do not prove a running session has
  migrated.

# Worktrees and Standing Rules

- Worktrees are permitted ONLY when the owner or another agent launched by the
  owner is concurrently working on the same repository as an agent. Isolation
  alone, dirty local state, ordinary setup, review, builds, and agent-initiated
  fan-out never justify a worktree.
- Do not install or use persistent-memory extensions, memory-writing/search
  tools, automated learning, or memory-injected prompts. Correct standing rules
  directly in AGENTS.md; keep task state in todos or handoffs and reusable
  procedures in tracked skills, not a separate memory store.

# Nix Style Guidelines

- Shared skills may contain tool names for multiple harnesses. Before following
  a named tool procedure in Pi, verify that the tool is actually exposed. If
  not, use an available semantically equivalent tool while preserving exact
  scope, exclusions, and mutation boundaries. Never stop merely because another
  harness's tool name appears in `allowed-tools`, and never treat that
  substitution as evasion.
- **Flatten small attribute sets**: When an attrset has fewer than 3 items (1 or
  2), use dotted paths instead of nesting:

  ```nix
  # Good
  fzf.enable = true;
  fzf.enableZshIntegration = true;

  # Bad
  fzf = {
    enable = true;
    enableZshIntegration = true;
  };
  ```

- **Group related attrs**: Consolidate repeated top-level keys into a single
  block (e.g. one `programs = { ... };` instead of many `programs.foo = ...;`
  blocks)
- **nixfmt**: The repo uses nixfmt for formatting

# Neovim Config

## Testing requirements

After any change to nvim keybindings, mappings, or the README cheatsheet, run
the mapping tests before committing:

```bash
nvim --headless -c "luafile nvim/test_mappings.lua" -c "qa!"
```

All tests must pass. If you add, remove, or change a binding in
`lua/plugins/astrocore.lua`, update `test_mappings.lua` to match. If you change
the README cheatsheet, update the tests to match. The tests are the source of
truth for what the config should do — never commit mapping changes without
verifying them.

Common mistakes to avoid:

- Using `<Leader>SPC` instead of `<Leader><Space>` (nvim doesn't recognize the
  former)
- Overriding AstroNvim defaults without disabling them first (e.g., `<Leader>c`
  is bound to close buffer by default — must set to `false` before adding
  submappings)
- Adding a binding to the README without adding it to the config (or vice versa)

# fj — unified dev command

`fj` (aliases `f`, `j`) is a nushell module at `nushell/fj/` that is the user's
single entry point for day-to-day version control and dev chores. It dispatches
a subcommand to the right underlying tool: `git`, `but`, `gh`, or an internal
workflow (`do`, `check`, `take`, `md`, `infra`). Run `fj help` for the full
command list.

## VCS backend routing

Prefer GitButler for managed main worktrees and plain Git elsewhere. Stack-style
commands (`ss`, `create`, `sync`, `co`, `restack`, `mut`, …) retain compatible
aliases and route by verified topology:

- a GitButler-managed repository's verified main worktree → **`but`**
- every linked/non-main worktree → plain **`git`**
- otherwise → plain **`git`**

Never invoke GitButler outside the main worktree; detect topology before routing
instead of waiting for `but` to fail. These are shared defaults, not
organization-specific rules; explicit repository-local workflows may override
them. Do not migrate repositories, change branches, or rewrite history merely to
select a backend.

Plain git commands (`add`, `commit`, `push`, `status`, `diff`, `log`, …) always
route to `git` regardless of backend. `gh`-backed commands (`issue`, `pr`) and
internal workflows are backend-independent.

The stack **verbs are translated**, not passed through — gitbutler has a
different vocabulary and no stack cursor. For example `fj mut` → `but amend` /
`git commit --amend`; `fj co` → `but apply` / `git checkout`; `fj create` →
`but branch new` / `git checkout -b`. Legacy verbs with no equivalent (the
`up`/`down`/`top`/`bottom` cursor moves, and on git also
`squash`/`absorb`/`move`/…) error with a clear message instead of being guessed
at. The translation tables are `but_translations` and `git_translations` in
`routing.nu`.

## Routing internals

`nushell/fj/routing.nu` holds the pure, testable routing logic:

- `fj-route ...args` — maps the invocation to `{ tool, args }` (logical routing;
  stack commands carry tool `"stack"`)
- `vcs-backend cwd home gitbutler_managed is_main_worktree` — resolves
  `"but" | "git"`; path arguments remain for compatibility, not
  organization-based routing
- `resolve-stack route backend` — translates a stack route (tool `"stack"`) to
  the active backend, mapping both the tool and the verb; returns tool
  `"unsupported"` (carrying `[verb, backend]`) when there is no equivalent.
  Non-stack routes pass through unchanged.

`mod.nu` verifies Git topology and management evidence, resolves the backend,
and dispatches; an `"unsupported"` route errors with a clear message. Run the
unit tests after any routing change:

```bash
nu nushell/fj/routing.test.nu
```

# Agent Delivery

Use type-only Conventional Commit prefixes such as `fix:`, `feat:`, `refactor:`,
`test:`, and `docs:` according to the change. Do not use `wip(pi):`.

Work on `master` and commit and push validated changes directly to `master`,
unless the owner explicitly authorizes another branch or says not to publish. Do
not create or use an agent feature branch based on an inherited checkout,
summary, checkpoint, or handoff. Committing and pushing are routine completion
steps here; do not hand them back to the owner or request redundant
authorization.

# Work Tracking

Use GitHub issues/PRs for current project tracking. Preserve historical tracker
records; changing the current toolchain does not authorize external cleanup.

Name each task for one concrete action or outcome. Keep attribution, recency,
priority, and constraints in its details, not generic title prefixes. Split
independent deliverables into separate tasks and use artifact-level subtasks to
show processing stages and progress.

Keep SPEC/ROADMAP → GitHub issues → local execution tasks as the planning
hierarchy. Aim for approximately 95% of substantive local tasks to link to an
issue, with explicit short-lived one-off exceptions. Notes and memories provide
context rather than a competing backlog.

# Current environment

Do not treat retired organization layouts or services as the current
environment. Verify relevant configuration before making operational claims; do
not invent a replacement layout. Documentation changes do not authorize service
changes, filesystem cleanup, or deletion of historical records.
