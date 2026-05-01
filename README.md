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

| File               | Purpose                                             |
| ------------------ | --------------------------------------------------- |
| `flake.nix`        | Flake definition, system configs, helper scripts    |
| `common.nix`       | Shared packages and settings (both platforms)       |
| `darwin.nix`       | macOS-specific: homebrew, GUI apps, hostname        |
| `nixos.nix`        | NixOS-specific: SSH, firewall, users                |
| `digitalocean.nix` | Disk/boot config for DO droplets                    |
| `home.nix`         | Home Manager: git, zsh, neovim, zellij, fzf, direnv |
| `nvim/`            | Neovim config (AstroNvim v5)                        |
| `doom/`            | Doom Emacs config (nix-doom-emacs-unstraightened)   |
| `nushell/`         | Nushell config, `fj` command, and md sync           |
| `zellij/`          | Terminal multiplexer config                         |
| `karabiner/`       | Keyboard remapping (caps lock -> ctrl/esc)          |

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

| Command        | Purpose                                  |
| -------------- | ---------------------------------------- |
| `fj md plan`   | Compute a sync plan                      |
| `fj md diff`   | Show unified diffs for planned changes   |
| `fj md sync`   | Apply a previously generated plan        |
| `fj md`        | Run plan + diff + apply in one step      |

Config lives at `~/.config/mdaemon.nuon`:

```nushell
{ vault: "~/code/notes", orgs: ["~/code/st0x"] }
```

## Remote Claude Code

On-demand DigitalOcean instance running Claude Code with remote control, accessible
from claude.ai/code or the mobile app. Zero public ports -- all traffic is outbound
HTTPS. SSH only via Tailscale.

### Prerequisites

- SSH keypair at `~/.ssh/nixxxos_ed25519` (all tools default to this)
- DigitalOcean API token encrypted in `infra/terraform.tfvars.age`
- Tailscale auth key (generate at https://login.tailscale.com/admin/settings/keys)

### Commands

All via `fj genie` (or `jf genie`):

| Command                | Purpose                                             |
| ---------------------- | --------------------------------------------------- |
| `fj genie`             | Show instance status (IP, tailnet, service)         |
| `fj genie bottle`      | Plan infrastructure (saves plan file)               |
| `fj genie bottle open` | Apply saved plan (creates the DO droplet)           |
| `fj genie bootstrap`   | Install NixOS via nixos-anywhere, join Tailscale    |
| `fj genie talk`        | SSH in + attach to zellij session with Claude Code  |
| `fj genie murder`      | Destroy the instance                                |

### First-time setup

```bash
fj genie bottle
fj genie bottle open
TS_AUTHKEY=tskey-auth-... fj genie bootstrap

# one-time: authenticate claude code
ssh 0xgleb@<tailnet-ip>
claude auth login
sudo systemctl start claude-remote-control
```

After that, `fj genie talk` to connect.

### How it works

- `fj genie bottle` runs `terraform plan -out` with encrypted vars, saving a
  plan file; `bottle open` applies it
- `fj genie bootstrap` runs `nixos-anywhere` to install NixOS from
  `flake.nix#nixxxos`, waits for the host, and joins Tailscale if `TS_AUTHKEY`
  is set
- `fj genie talk` SSHes via Tailscale and attaches to a named zellij session
- `nixos.nix` defines a `claude-remote-control` systemd service that runs
  `claude remote-control --name nixxxos --spawn worktree` as user `0xgleb`
- Remote control is outbound-only (no inbound ports) -- Anthropic's API relays
  between the local process and claude.ai/code or the mobile app
- Zero public ports; SSH only via `tailscale0` trusted interface
- `linger = true` keeps the service alive without an active login session

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
