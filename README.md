# ~/.config/

> The home directory looked like a mobile declarative laboratory. We had two
> flakes, seventy-five system packages, five sheets of high-powered elisp, a
> salt shaker half full of evil-mode keybindings, and a whole galaxy of
> multi-colored doom modules, LSP servers, formatters, linters... and also a
> quart of zellij, a quart of karabiner, a case of AI CLI tools, a pint of raw
> terraform and two dozen shell aliases. Not that we needed all that for the
> config, but once you get locked into a serious dotfiles collection, the
> tendency is to push it as far as you can.

Nix flake managing two targets from a single repo:

- **darwwwin** -- macOS workstation (aarch64-darwin) via nix-darwin
- **nixxxos** -- NixOS server on DigitalOcean (x86_64-linux)

## Structure

| File               | Purpose                                                           |
| ------------------ | ----------------------------------------------------------------- |
| `flake.nix`        | Flake definition, system configs, helper scripts                  |
| `common.nix`       | Shared packages and settings (both platforms)                     |
| `darwin.nix`       | macOS-specific: homebrew, GUI apps, hostname                      |
| `nixos.nix`        | NixOS-specific: SSH, firewall, Tailscale, OpenClaw                |
| `digitalocean.nix` | Disk/boot config for DO droplets                                  |
| `infra/`           | Terraform (droplet + Tailscale keys) and provision/deploy scripts |
| `home.nix`         | Home Manager: git, zsh, neovim, zellij, fzf, direnv               |
| `nvim/`            | Neovim config (AstroNvim v5)                                      |
| `doom/`            | Doom Emacs config (nix-doom-emacs-unstraightened)                 |
| `nushell/`         | Nushell config, `fj` command, and md sync                         |
| `zellij/`          | Terminal multiplexer config                                       |
| `karabiner/`       | Keyboard remapping (caps lock -> ctrl/esc)                        |

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
tailnet declaratively and runs [OpenClaw](https://github.com/openclaw/openclaw)
(self-hosted personal agent) as a native systemd gateway via the
[`nix-openclaw`](https://github.com/openclaw/nix-openclaw) module. Its model
backends are existing **subscriptions**, not paid APIs: Cursor via the acpx ACP
harness (`cursor-agent`), with Claude Code CLI as a fallback.

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
> auth keys it mints. Rotate the API token, re-run `provision` (re-mints +
> re-seeds the node key), and refresh the `TS_AUTHKEY` GitHub secret from the
> new CI key on that cadence.

On the box, runtime secrets are plain root-only files under `/var/lib/secrets/`,
seeded at install time and persisted across rebuilds:

| File                                 | Purpose                                       |
| ------------------------------------ | --------------------------------------------- |
| `/var/lib/secrets/tailscale.authkey` | Tailscale node key (auto-join on first boot)  |
| `/var/lib/secrets/openclaw.env`      | OpenClaw secrets (Cursor key, channel tokens) |

The OpenClaw secrets are declarative: set `openclaw_env` via `nix run .#tfVars`
(e.g. `openclaw_env = "CURSOR_API_KEY=..."`) and `provision` seeds the file.

### Provision (first install)

```bash
nix run .#provision
```

This applies Terraform and installs NixOS via nixos-anywhere, seeding
`/var/lib/secrets/`. The box then joins the tailnet on first boot. Because the
node is untagged, **disable key expiry** for it in the Tailscale admin console
(Machines → nixxxos → Disable key expiry), or its default 180-day expiry will
drop it off the tailnet.

### OpenClaw model auth (one-time, on the box)

OpenClaw drives the first-party CLIs, which use your subscriptions. These are
runtime steps (not declarative); do them once on the box (over the tailnet):

```bash
ssh nixxxos
sudo -u openclaw -H bash -lc '
  cursor-agent login                 # Cursor sub (or set CURSOR_API_KEY in openclaw.env)
  claude setup-token                 # Claude sub fallback; then unset ANTHROPIC_API_KEY
  openclaw plugins install @openclaw/acpx
  openclaw config set plugins.entries.acpx.enabled true
  openclaw acp doctor                # confirm the cursor ACP backend is healthy
'
```

`cursor-agent` is the explicitly-permitted path; the Claude `claude-cli` backend
is a fallback and sits in an Anthropic-ToS gray zone. Finalize "Cursor answers
messages" routing via `/acp doctor`; redeploys are cheap (OpenClaw is
substituted from the garnix cache, not built).

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
3. Deploy once locally (`nix run .#provision` or a manual `nixos-rebuild`) so
   the `ci` key lands in the box's authorized_keys before CI first runs.

> OpenClaw is substituted from the garnix cache (wired up in `common.nix`), so
> neither the runner nor the box builds it from source.

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
