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
- **The Nix flake** -- one flake managing two hosts: **darwwwin**, a macOS
  workstation (aarch64-darwin) via nix-darwin, and **nixxxos**, a NixOS server
  on DigitalOcean (x86_64-linux).

## Structure

| Path                    | Purpose                                                           |
| ----------------------- | ----------------------------------------------------------------- |
| `ai/`                   | Agent setup: Pi extensions, shared skills, harness hooks and policy |
| `nushell/`              | Nushell config, `fj` command, and md sync                         |
| `flake.nix`             | Flake definition, system configs, helper scripts                  |
| `common.nix`            | Shared packages and settings (both platforms)                     |
| `darwin.nix`            | macOS-specific: homebrew, GUI apps, hostname                      |
| `nixos.nix`             | NixOS-specific: SSH, firewall, Tailscale                          |
| `digitalocean.nix`      | Disk/boot config for DO droplets                                  |
| `infra/`                | Terraform (droplet + Tailscale keys) and provision/deploy scripts |
| `home.nix`              | Home Manager: git, zsh, neovim, zellij, fzf, direnv               |
| `nvim/`                 | Neovim config (AstroNvim v5)                                      |
| `doom/`                 | Doom Emacs config (nix-doom-emacs-unstraightened)                 |
| `zellij/`               | Terminal multiplexer config                                       |
| `karabiner/`            | Keyboard remapping (caps lock -> ctrl/esc)                        |

## Agents

`ai/` holds everything the coding agents share, so a rule or skill is written
once and every harness picks it up.

| Path                  | Purpose                                                        |
| --------------------- | -------------------------------------------------------------- |
| `ai/AGENTS.md`        | Global agent instructions (symlinked as `~/.claude/CLAUDE.md`)  |
| `ai/skills/`          | Shared skills, symlinked into both Claude and Cursor            |
| `ai/hooks/`           | Harness hooks that enforce policy mechanically                  |
| `ai/pi/extensions/`   | Pi extensions, including the agent registry and remote-control bridge |
| `ai/*.settings.json`  | Per-harness settings (Claude, Cursor, Pi)                       |

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

| Hook                       | Enforces                                                       |
| -------------------------- | -------------------------------------------------------------- |
| `delegation-nudge.nu`      | Nudges toward delegating a run of inline edits to subagents     |
| `private-comms-guard.nu`   | Blocks publishing commands that would leak private agent-bus communication into public artifacts |

## Shell

**Nushell** is the primary shell. `fj` (also aliased as `jf`) unifies version
control and developer tools:

| Command                              | Routes to              |
| ------------------------------------ | ---------------------- |
| `fj`                                 | `git status` + `gt ls` |
| `fj ui`                              | `gitui`                |
| `fj pr list`, `fj pr view 123`       | `gh pr ...`            |
| `fj issue list`, `fj issue create`   | `gh issue ...`         |
| `fj mut`, `fj mut -a`                | `gt modify ...`        |
| `fj ss`, `fj create`, `fj sync`, ... | `gt` (graphite)        |
| `fj check`                           | repo-specific checks   |
| anything else                        | `git`                  |

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
{ vault: "~/code/notes", orgs: ["~/code/st0x"] }
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
- NixOS only: `nixos.nix`

## Remote server (nixxxos)

The `nixxxos` droplet is provisioned with Terraform and installed with
nixos-anywhere. Terraform also mints the Tailscale auth keys; NixOS joins the
tailnet declaratively. There is no resident agent service — run one manually over
the tailnet (`ssh nixxxos`, then `fj clanker`, which launches Pi; use `fj clanker
--claude` to launch Claude Code with `--remote-control` for claude.ai / mobile; see
"Running an agent on the box" below).

### Secrets

Infra credentials live encrypted in `infra/terraform.tfvars.age` (DigitalOcean
token + Tailscale API key). Edit them with:

```bash
nix run .#tfVars   # decrypt, edit in $EDITOR, re-encrypt
```

Terraform state (`infra/terraform.tfstate`) uses the default local backend and
is gitignored, but holds the generated secrets (DO token, Tailscale keys) in
plaintext — the intentional model for this personal repo. Keep it on an
encrypted disk; it is never committed.

> Tailscale credentials all expire after 90 days: the API token **and** the two
> auth keys it mints. Rotate the API token, then re-mint the **node** key with
> `nix run .#tfApply -- -replace=tailscale_tailnet_key.node` and re-seed it onto
> the box by rebuilding (`nix run .#decommission` then `nix run .#provision`,
> since the node key is only staged at install time). Re-mint the **CI** key on
> the same cadence with `nix run .#tfApply -- -replace=tailscale_tailnet_key.ci`
> and copy the new `tailscale_ci_authkey` output into the `TS_AUTHKEY` GitHub
> secret.

On the box, runtime secrets are plain root-only files under `/var/lib/secrets/`,
seeded at install time and persisted across rebuilds:

| File                                 | Purpose                                       |
| ------------------------------------ | --------------------------------------------- |
| `/var/lib/secrets/tailscale.authkey` | Tailscale node key (auto-join on first boot)  |

The node key is seeded **only at install time** (`nixos-anywhere --extra-files`)
and removed once tailscaled has joined and persisted its state, after which the
box stays on the tailnet across rebuilds without it.

### Provision and decommission

```bash
nix run .#provision      # stand up the box (idempotent) and connect
nix run .#decommission   # tear the box down

# or via fj:
fj infra provision
fj infra decommission
```

`provision` applies Terraform and, **only when no box already exists in
terraform state**, installs NixOS via nixos-anywhere (seeding
`/var/lib/secrets/`). An existing box is left intact — it is never `-replace`d —
so re-running `provision` is safe. Once the box is reachable over the tailnet,
`provision` SSHes in (over the tailnet, since public SSH is closed) as
`-i ~/.ssh/dotconfig-nixos` and attaches a zellij session named `nixxxos`; if it
isn't reachable yet it prints the manual connect command instead of hanging.
Because the node is untagged, **disable key expiry** for it in the Tailscale
admin console (Machines → nixxxos → Disable key expiry), or its default 180-day
expiry will drop it off the tailnet.

`decommission` runs `terraform destroy` (droplet + Tailscale auth keys) and
clears the local host-key pin. To rebuild from scratch: `decommission` then
`provision`; to change an existing box without recreating it, use the CD deploy.

> A fresh install seeds the node auth key at install time
> (`nixos-anywhere --extra-files`). If install fails partway (disk wiped, NixOS
> not yet activated), the box is left unbootable — `decommission` then re-run
> `provision`.

### Running an agent on the box (manual)

There is no resident agent service; start Claude Code by hand over the tailnet.
Sign in once with a claude.ai account (remote control needs OAuth, not an API
key):

```bash
ssh nixxxos
claude /login        # claude.ai account; required for remote control
```

Then launch it with `fj clanker --claude`. On the `nixxxos` host the Claude route
automatically adds `--remote-control`, so the session is drivable from claude.ai
and the Claude mobile app. Plain `fj clanker` launches Pi instead.

### Deploy (CI/CD)

Every push to `master` runs `nix flake check`, builds the NixOS toplevel, and —
on a green build — deploys it to `nixxxos` over the tailnet
(`.github/workflows/ci.yml`). One-time setup:

1. Generate a deploy keypair; put the **public** key in `keys.nix` as `ci` and
   the **private** key in the repo secret `DEPLOY_SSH_KEY`.
2. Put the CI Tailscale key in the repo secret `TS_AUTHKEY`:
   ```bash
   terraform -chdir=infra output -raw tailscale_ci_authkey
   ```
   The CI runner joins the tailnet as an untagged ephemeral node, so it gets the
   tailnet's default ACL (full access). To restrict it, define an ACL tag (e.g.
   `tag:ci`) in the Tailscale admin console and add `tags = ["tag:ci"]` to
   `tailscale_tailnet_key.ci` in `infra/main.tf` — the tag must exist in the
   policy first or `terraform apply` rejects it.
3. Deploy once locally (`nix run .#provision` or a manual `nixos-rebuild`) so
   the `ci` key lands in the box's authorized_keys before CI first runs.

> Optional hardening: set the `NIXXXOS_KNOWN_HOSTS` repo secret to nixxxos's SSH
> host key (`ssh-keyscan` it over the tailnet right after provision) to pin the
> host instead of trusting on first use. The deploy authenticates over the
> tailnet (WireGuard) regardless; pinning just makes it independent of tailnet
> ACL correctness. Without it the deploy uses trust-on-first-use **every** run
> (runners are ephemeral), so set it for ongoing hardening, not just once. A
> reprovision regenerates the host key, so refresh the secret afterwards or the
> pinned deploy will fail host-key verification. Until both `TS_AUTHKEY` and
> `DEPLOY_SSH_KEY` are set, the deploy job skips cleanly rather than failing
> every push to `master`.

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
