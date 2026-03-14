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
| `nushell/`         | Nushell config and environment                      |
| `zellij/`          | Terminal multiplexer config                         |
| `karabiner/`       | Keyboard remapping (caps lock -> ctrl/esc)          |

## Shell

**Nushell** is the primary shell. `fj` unifies version control tools:

| Command                              | Routes to              |
| ------------------------------------ | ---------------------- |
| `fj`                                 | `git status` + `gt ls` |
| `fj ui`                              | `gitui`                |
| `fj pr list`, etc.                   | `gh pr list`           |
| `fj mut`                             | `gt modify`            |
| `fj ss`, `fj create`, `fj sync`, ... | `gt` (graphite)        |
| anything else                        | `git`                  |

## Build

```bash
darwin-rebuild switch --flake ~/.config
darwin-rebuild build --flake ~/.config
nixfmt *.nix
```
