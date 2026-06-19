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

| File                    | Purpose                                                           |
| ----------------------- | ----------------------------------------------------------------- |
| `flake.nix`             | Flake definition, system configs, helper scripts                  |
| `common.nix`            | Shared packages and settings (both platforms)                     |
| `darwin.nix`            | macOS-specific: homebrew, GUI apps, hostname                      |
| `mullvad-wireguard.nix` | macOS: Mullvad-as-WireGuard so Tailscale coexists with the VPN    |
| `nixos.nix`             | NixOS-specific: SSH, firewall, Tailscale, OpenClaw                |
| `digitalocean.nix`      | Disk/boot config for DO droplets                                  |
| `infra/`                | Terraform (droplet + Tailscale keys) and provision/deploy scripts |
| `home.nix`              | Home Manager: git, zsh, neovim, zellij, fzf, direnv               |
| `nvim/`                 | Neovim config (AstroNvim v5)                                      |
| `doom/`                 | Doom Emacs config (nix-doom-emacs-unstraightened)                 |
| `nushell/`              | Nushell config, `fj` command, and md sync                         |
| `zellij/`               | Terminal multiplexer config                                       |
| `karabiner/`            | Keyboard remapping (caps lock -> ctrl/esc)                        |

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
> auth keys it mints. Rotate the API token, then re-run `provision` (it
> `-replace`s and re-seeds the **node** key, so the fresh box joins with a live
> key). The **CI** key is left alone by `provision` so a reprovision doesn't
> silently invalidate `TS_AUTHKEY`; re-mint it on the same cadence with
> `nix run .#tfApply -- -replace=tailscale_tailnet_key.ci` and copy the new
> `tailscale_ci_authkey` output into the `TS_AUTHKEY` GitHub secret.

On the box, runtime secrets are plain root-only files under `/var/lib/secrets/`,
seeded at install time and persisted across rebuilds:

| File                                 | Purpose                                       |
| ------------------------------------ | --------------------------------------------- |
| `/var/lib/secrets/tailscale.authkey` | Tailscale node key (auto-join on first boot)  |
| `/var/lib/secrets/openclaw.env`      | OpenClaw secrets (Cursor key, channel tokens) |

The OpenClaw secrets are declarative: set `openclaw_env` via `nix run .#tfVars`
(e.g. `openclaw_env = "CURSOR_API_KEY=..."`) and `provision` seeds the file.

> The file is seeded **only at install time** (`nixos-anywhere --extra-files`).
> The CD deploy (`nixos-rebuild switch`) does **not** re-seed it, so changing
> `openclaw_env` in tfvars only reaches the box on the next `provision` (a
> destructive reinstall) — or edit `/var/lib/secrets/openclaw.env` on the box
> directly. Activation guarantees the file exists (empty if unset) so the
> gateway never fails to start on a missing file.

### Provision (first install)

```bash
nix run .#provision
```

This applies Terraform and installs NixOS via nixos-anywhere, seeding
`/var/lib/secrets/`. The box joins the tailnet on first boot, and `provision`
waits for it to become reachable over the tailnet before reporting success —
if it times out, check `tailscaled` from the DigitalOcean console. Because the
node is untagged, **disable key expiry** for it in the Tailscale admin console
(Machines → nixxxos → Disable key expiry), or its default 180-day expiry will
drop it off the tailnet.

> `provision` is destructive: it `-replace`s the droplet and nixos-anywhere
> wipes the disk. If it fails partway (e.g. after the disk is wiped but before
> NixOS activates), the box is left unbootable — just re-run `nix run .#provision`
> to reinstall from scratch.

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
messages" routing via `/acp doctor`.

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

> Optional hardening: set the `NIXXXOS_KNOWN_HOSTS` repo secret to nixxxos's SSH
> host key (`ssh-keyscan` it over the tailnet right after provision) to pin the
> host instead of trusting on first use. The deploy authenticates over the
> tailnet (WireGuard) regardless; pinning just makes it independent of tailnet
> ACL correctness. Until `DEPLOY_SSH_KEY` is set, the deploy job skips cleanly
> rather than failing every push to `master`.

> OpenClaw currently builds from source (the runner builds it on CI/deploy; a
> fresh `provision` builds it on the box). Wire up a Cachix cache to have CI
> push it once and everyone pull it prebuilt — keeps the box light.

## Mullvad + Tailscale (macOS)

Two full-tunnel VPNs can't both own the macOS default route, and Mullvad's
app/CLI split tunnel only excludes app _binaries_ — which can't carve out
Tailscale's CGNAT range (its data path is a separate system extension). So
`mullvad-wireguard.nix` runs **Mullvad as a raw WireGuard tunnel** (launchd
daemon) with `AllowedIPs` = everything except the tailnet (`100.64.0.0/10` +
`fd7a:115c:a1e0::/48`). Mullvad tunnels everything else; tailnet traffic
bypasses it, so Tailscale stays reachable with Mullvad up.

One-time setup (the private key stays out-of-store, so it's not in the flake):

```bash
# Generate a WireGuard config at https://mullvad.net/en/account/wireguard-config
# (new key, pick a server, download), then:
sudo install -m600 -D ~/Downloads/<server>.conf /etc/wireguard/mullvad.conf
darwin-rebuild switch --flake ~/.config
```

The daemon rewrites that config's `AllowedIPs` and brings the tunnel up at boot;
until the file exists it changes nothing. Don't also run the Mullvad GUI app.
Rollback: delete `/etc/wireguard/mullvad.conf` and rebuild (or
`sudo wg-quick down /var/run/mullvad-split.conf`).

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
