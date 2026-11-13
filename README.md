# ~/.config/

> The home directory looked like a mobile agent laboratory. We had two dozen Pi
> extensions, forty sheets of high-powered skills, five harness policies, a salt
> shaker half full of nushell, and a whole galaxy of multi-colored lanes,
> orchestrators, dispatchers, drainers, research workers... and also a quart of
> zellij, a quart of karabiner, a case of doom modules, a pint of raw terraform
> and two flakes. Not that we needed all that for the config, but once you get
> locked into a serious dotfiles collection, the tendency is to push it as far
> as you can.

Three layers, largest first:

- **The agent setup** (`ai/`) -- Pi extensions, shared skills, and harness
  policy. TypeScript, and by volume most of this repo.
- **Shell tooling** (`nushell/`) -- nushell config and the `fj` command.
- **The Nix flake** -- manages **darwwwin**, a macOS workstation
  (aarch64-darwin), via nix-darwin.

## Structure

| Path         | Purpose                                                             |
| ------------ | ------------------------------------------------------------------- |
| `ai/`        | Agent setup: Pi extensions, shared skills, harness hooks and policy |
| `nushell/`   | Nushell config, `fj` command, and md sync                           |
| `flake.nix`  | Flake definition, system configs, helper scripts                    |
| `common.nix` | Shared packages and settings (both platforms)                       |
| `darwin.nix` | macOS-specific: homebrew, GUI apps, hostname                        |
| `home.nix`   | Home Manager: git, zsh, neovim, zellij, fzf, direnv                 |
| `nvim/`      | Neovim config (AstroNvim v5)                                        |
| `doom/`      | Doom Emacs config (nix-doom-emacs-unstraightened)                   |
| `zellij/`    | Terminal multiplexer config                                         |
| `karabiner/` | Keyboard remapping (caps lock -> ctrl/esc)                          |

## Agents

`ai/` holds everything the coding agents share, so a rule or skill is written
once and every harness picks it up.

| Path                 | Purpose                                                               |
| -------------------- | --------------------------------------------------------------------- |
| `ai/AGENTS.md`       | Global agent instructions (symlinked as `~/.claude/CLAUDE.md`)        |
| `ai/skills/`         | Shared skills, symlinked into both Claude and Cursor                  |
| `ai/hooks/`          | Harness hooks that enforce policy mechanically                        |
| `ai/pi/extensions/`  | Pi extensions, including the agent registry and remote-control bridge |
| `ai/*.settings.json` | Per-harness settings (Claude, Cursor, Pi)                             |

### The agent bus

Several agent sessions run at once, one per project, plus cheaper research
lanes. They coordinate through two SQLite-backed stores rather than by talking
to each other directly:

- **A roster.** Each session registers with `pi-bridge register` and keeps the
  registration alive with a heartbeat well under `BRIDGE_AGENT_TTL_MS`, or it
  silently drops off and stops being addressable.
- **Per-project queues.** Work is filed against a project path and drained by
  the one session holding that project's role, which is what keeps two sessions
  from executing the same item.
- **A per-lane inbox.** Messages addressed to a session are claimed with
  `pi-bridge inbox` and answered with `pi-bridge respond`. Claiming does not
  extend the deadline, so a claimed message is handled in the same iteration.

The `register` skill is the single entry point that does all of this: join the
roster, hold the project role, arm the poll loop, drain one iteration, yield.

### Hooks

Hooks enforce what instructions alone do not. They are wired in
`ai/claude.settings.json` and run as ordinary nushell scripts:

| Hook                     | Enforces                                                                                         |
| ------------------------ | ------------------------------------------------------------------------------------------------ |
| `delegation-nudge.nu`    | Nudges toward delegating a run of inline edits to subagents                                      |
| `private-comms-guard.nu` | Blocks publishing commands that would leak private agent-bus communication into public artifacts |

## Shell

**Nushell** is the primary shell. `fj` (also aliased as `jf`) unifies version
control and developer tools:

| Command                              | Routes to                                                       |
| ------------------------------------ | --------------------------------------------------------------- |
| `fj`                                 | `but status` on a managed GitButler worktree, else `git status` |
| `fj ui`                              | `gitui`                                                         |
| `fj pr list`, `fj pr view 123`       | `gh pr ...`                                                     |
| `fj issue list`, `fj issue create`   | `gh issue ...`                                                  |
| `fj mut`, `fj mut -a`                | `but amend` / `git commit --amend`                              |
| `fj ss`, `fj create`, `fj sync`, ... | `but` or `git`, translated per repo topology                    |
| `fj check`                           | repo-specific checks                                            |
| plain git subcommands (`fj add`, …)  | `git`                                                           |
| anything else                        | error: unknown command                                          |

### Markdown vault sync (`fj md`)

Terraform-like plan/apply for syncing markdown files between source repos and an
Obsidian vault.

| Command      | Purpose                                |
| ------------ | -------------------------------------- |
| `fj md plan` | Compute a sync plan                    |
| `fj md diff` | Show unified diffs for planned changes |
| `fj md sync` | Apply a previously generated plan      |
| `fj md`      | Run plan + diff + apply in one step    |

Config lives at `~/.config/mdaemon.nuon`:

```nushell
{ vault: "~/code/notes", orgs: ["~/code/dataclique", "~/code/0xgleb"] }
```

## Build

```bash
darwin-rebuild switch --flake ~/.config
darwin-rebuild build --flake ~/.config
nixfmt *.nix
```

## Adding packages

- Shared (both platforms): `common.nix`
- macOS only: `darwin.nix`

---

## For contributors and agents

See `CLAUDE.md` at the repo root for coding guidelines, architecture details,
and workflow rules. Per-directory `CLAUDE.md` and `README.md` files provide
additional context for specific areas.

### Documentation organization

- **README.md**: user-facing docs at top, contributor summary at bottom
- **CLAUDE.md**: contributor and agent instructions
- Root-level files cover high-level guidelines; per-directory files cover
  concrete, detailed instructions for that area
