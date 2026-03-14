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

| File               | Purpose                                           |
| ------------------ | ------------------------------------------------- |
| `flake.nix`        | Flake definition, system configs, helper scripts  |
| `common.nix`       | Shared packages and settings (both platforms)     |
| `darwin.nix`       | macOS-specific: homebrew, GUI apps, hostname      |
| `nixos.nix`        | NixOS-specific: SSH, firewall, users              |
| `digitalocean.nix` | Disk/boot config for DO droplets                  |
| `home.nix`         | Home Manager: git, zsh, neovim, zellij, fzf, direnv |
| `nvim/`            | Neovim config (AstroNvim v5)                      |
| `doom/`            | Doom Emacs config (nix-doom-emacs-unstraightened) |
| `nushell/`         | Nushell config and environment                    |
| `zellij/`          | Terminal multiplexer config                       |
| `karabiner/`       | Keyboard remapping (caps lock -> ctrl/esc)        |

## Editors

**Neovim** with AstroNvim v5. Keybindings mirror Doom Emacs (SPC-leader). Mason
disabled -- all LSPs and tools come from nix (system-level or per-repo flakes
via direnv). Language packs: rust, nix, typescript, haskell, solidity,
terraform, markdown, json, yaml, toml, html/css.

**Doom Emacs** managed declaratively via nix-doom-emacs-unstraightened. No
`doom sync` -- edit `doom/` files and rebuild.

## Shell

**Nushell** is the primary shell. The `fj` command unifies git, graphite, and
gitui:

- `fj` -- git status
- `fj ui` -- gitui
- `fj ss`, `fj create`, `fj sync`, etc. -- graphite
- `fj mut` -- gt modify
- Everything else -- git

## Build

```bash
# Build and apply
darwin-rebuild switch --flake ~/.config

# Build without applying
darwin-rebuild build --flake ~/.config

# Format nix files
nixfmt *.nix
```
