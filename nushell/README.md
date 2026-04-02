# Nushell Configuration

Nushell is the primary interactive shell. Configuration is loaded from this
directory via Home Manager (`programs.nushell` in `home.nix`).

## Files

| File          | Purpose                                              |
| ------------- | ---------------------------------------------------- |
| `config.nu`   | Shell settings, keybindings, prompt, module imports   |
| `env.nu`      | Environment variables (PATH, EDITOR)                 |
| `scripts/fj/` | `fj` command module (git, graphite, gh, md sync)     |

## The `fj` command

`fj` is a nushell module (`scripts/fj/mod.nu`) that unifies version control and
developer tooling into one command. It's loaded via `use scripts/fj/` in
`config.nu`. `jf` is aliased to `fj` for typo tolerance.

### Subcommands

- `fj` (no args) -- `git status` + `gt ls`
- `fj check` -- run repo-specific checks (cargo, bun, clippy, etc.)
- `fj issue <args>` -- `gh issue <args>`
- `fj pr <args>` -- `gh pr <args>`
- `fj ui` -- `gitui`
- `fj mut [-a]` -- `gt modify`
- `fj md [plan|diff|sync]` -- markdown vault sync
- graphite commands (`ss`, `create`, `sync`, `co`, ...) route to `gt`
- everything else routes to `git`

### Module structure

```
scripts/fj/
  mod.nu          -- main module, exports fj and subcommands
  mod.test.nu     -- integration tests (command registration)
  routing.nu      -- pure routing logic (testable without side effects)
  routing.test.nu -- routing unit tests
  check.nu        -- repo-specific check runner
  md/
    mod.nu            -- fj md subcommands (plan, diff, sync)
    lib.nu            -- mdup library (actions, diffs, plan/apply logic)
    sync-lib.nu       -- shared library (config, targets, file ops)
    mdup.nu           -- standalone CLI entrypoint (used by nix build)
    sync-daemon.nu    -- background sync daemon (launchd service)
    lib.test.nu       -- mdup library tests
    sync-lib.test.nu  -- sync library tests
```

## Running tests

```bash
nu nushell/scripts/fj/routing.test.nu
nu nushell/scripts/fj/mod.test.nu
nu nushell/scripts/fj/md/sync-lib.test.nu
nu nushell/scripts/fj/md/lib.test.nu
```

Or run all via nix:

```bash
nix flake check
```

---

## For contributors and agents

### Nushell coding conventions

- **Naming**: `kebab-case` for commands and flags, `snake_case` for variables
- **External commands**: always prefix with `^` (e.g. `^git`, `^diff`) to avoid
  shadowing by nushell commands or module exports
- **Modules vs source**: use `use` for module imports, `source` only in
  standalone scripts (concatenated by nix or run directly)
- **Exports**: only `export def` functions you intend to be used outside the
  file. Internal helpers stay private
- **Constants**: nushell `const` is not shared across `use` boundaries. If two
  files need the same constant, define it in both
- **Testing**: tests live alongside source with `.test.nu` suffix. Each test
  file has its own `def main` runner that discovers tests via `scope commands`
- **Immutability**: prefer immutable `let` over `mut`. Use pipelines and
  functional patterns over loops
- **Structured data**: use records and tables, not string parsing. Pipelines
  work with objects, not text
- **Error handling**: `try/catch` for expected errors, `do { } | complete` to
  capture exit codes without failing
