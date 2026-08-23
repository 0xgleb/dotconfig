# Neovim (AstroNvim)

AstroNvim v5 config managed alongside the nix-darwin flake.

## Prerequisites

1. **Nerd Font** -- installed via homebrew cask (`font-jetbrains-mono-nerd-font`
   in `darwin.nix`). Rebuild to install:

   ```bash
   darwin-rebuild switch --flake ~/.config
   ```

2. **iTerm2 setup**:
   - Preferences > Profiles > Text > Font > "JetBrainsMono Nerd Font"
   - Preferences > Profiles > Keys > "Use Option as Meta key" (for `M-x`)
   - Enable "Use ligatures" (optional)

   Without the Nerd Font, icons render as `?` boxes.

## Keybindings Cheatsheet

`SPC` = Space (leader key). Tap `SPC` and wait for which-key popup to explore.

### Quick Access

| Key       | Action                     |
| --------- | -------------------------- |
| `SPC SPC` | Find file in project       |
| `SPC /`   | Search project (grep)      |
| `SPC ,`   | Switch buffer              |
| `SPC :`   | Command palette            |
| `SPC ;`   | Enter ex command           |
| `SPC x`   | Close buffer               |
| `SPC j`   | Jump to word (flash)       |
| `M-x`     | Command palette (Option+x) |

### Buffer (`SPC b`)

| Key                   | Action                 |
| --------------------- | ---------------------- |
| `SPC b b`             | Switch buffer          |
| `SPC b n` / `SPC b p` | Next / previous buffer |
| `SPC b k` / `SPC b d` | Kill buffer            |
| `SPC b o`             | Kill other buffers     |
| `SPC b s` / `SPC b S` | Save / save all        |
| `SPC b r`             | Revert buffer          |
| `] b` / `[ b`         | Next / previous buffer |

### Code / LSP (`SPC c`)

| Key       | Action               |
| --------- | -------------------- |
| `SPC c d` | Go to definition     |
| `SPC c D` | Find references      |
| `SPC c a` | Code action          |
| `SPC c r` | Rename symbol        |
| `SPC c f` | Format buffer        |
| `SPC c i` | Go to implementation |
| `SPC c k` | Hover documentation  |
| `SPC c s` | Signature help       |
| `SPC c x` | List errors          |

### File (`SPC f`)

| Key                   | Action                        |
| --------------------- | ----------------------------- |
| `SPC f f`             | Find file                     |
| `SPC f r`             | Recent files                  |
| `SPC f s`             | Save file                     |
| `SPC f y` / `SPC f Y` | Yank relative / absolute path |
| `SPC f p`             | Find config file              |

### Git (`SPC g`)

| Key                   | Action                    |
| --------------------- | ------------------------- |
| `SPC g g`             | Git status (gitui)        |
| `SPC g b` / `SPC g B` | Blame line / blame buffer |
| `SPC g d`             | Diff                      |
| `SPC g p`             | Preview hunk              |
| `SPC g r` / `SPC g R` | Reset hunk / reset buffer |
| `SPC g S` / `SPC g U` | Stage / unstage hunk      |
| `] d` / `[ d`         | Next / previous hunk      |

### Help (`SPC h`)

| Key       | Action               |
| --------- | -------------------- |
| `SPC h k` | Describe keybindings |
| `SPC h h` | Help tags            |
| `SPC h m` | Man pages            |
| `SPC h t` | Change theme         |

### Open (`SPC o`)

| Key                   | Action                     |
| --------------------- | -------------------------- |
| `SPC o n` / `SPC o p` | Toggle file tree           |
| `SPC o N`             | File tree (reveal current) |
| `SPC o t`             | Terminal                   |

### Project (`SPC p`)

| Key       | Action               |
| --------- | -------------------- |
| `SPC p f` | Search project       |
| `SPC p r` | Recent project files |
| `SPC p p` | Switch project       |

### Search (`SPC s`)

| Key                   | Action                           |
| --------------------- | -------------------------------- |
| `SPC s s` / `SPC s S` | Search buffer / word at point    |
| `SPC s p` / `SPC s P` | Search project / word at point   |
| `SPC s d`             | Search directory                 |
| `SPC s b`             | Search buffers                   |
| `SPC s i` / `SPC s I` | Search symbols (doc / workspace) |
| `SPC s r`             | Resume last search               |

### Toggle (`SPC t`)

| Key       | Action                |
| --------- | --------------------- |
| `SPC t l` | Toggle line numbers   |
| `SPC t w` | Toggle word wrap      |
| `SPC t s` | Toggle spell check    |
| `SPC t f` | Toggle format on save |
| `SPC t d` | Toggle diagnostics    |

### Window (`SPC w`)

| Key                   | Action                             |
| --------------------- | ---------------------------------- |
| `SPC w h/j/k/l`       | Focus left/down/up/right           |
| `SPC w s` / `SPC w v` | Horizontal / vertical split        |
| `SPC w c` / `SPC w d` | Close window                       |
| `SPC w m`             | Maximize (close all other windows) |
| `SPC w o`             | Only window                        |
| `SPC w w` / `SPC w W` | Next / previous window             |
| `SPC w =`             | Balance windows                    |
| `SPC w H/J/K/L`       | Move window left/down/up/right     |

### Quit (`SPC q`)

| Key       | Action              |
| --------- | ------------------- |
| `SPC q q` | Quit                |
| `SPC q Q` | Quit without saving |
| `SPC q s` | Save and quit       |

### Diagnostics

| Key           | Action                     |
| ------------- | -------------------------- |
| `] e` / `[ e` | Next / previous diagnostic |

### Terminal

| Key      | Action             |
| -------- | ------------------ |
| `Ctrl+\` | Exit terminal mode |

### Useful Built-in Commands

| Command            | Action                         |
| ------------------ | ------------------------------ |
| `:LspInfo`         | Show attached LSP clients      |
| `:checkhealth lsp` | Diagnose LSP issues            |
| `:Lazy`            | Plugin manager                 |
| `:Mason`           | Disabled — LSP servers come from Nix, not Mason |

## Structure

| File                 | Purpose                          |
| -------------------- | -------------------------------- |
| `init.lua`           | Entry point, loads lazy.nvim     |
| `lua/lazy_setup.lua` | Plugin manager bootstrap         |
| `lua/community.lua`  | AstroNvim community plugin packs |
| `lua/polish.lua`     | Post-setup customizations        |
| `lua/plugins/`       | Per-plugin configuration         |

## Adding plugins

Create a new file in `lua/plugins/` returning a lazy.nvim spec:

```lua
---@type LazySpec
return {
  "author/plugin-name",
  opts = {},
}
```

## Adding language support

Add language packs via `lua/community.lua` (e.g.,
`{ import = "astrocommunity.pack.rust" }`), or configure treesitter/LSP/linters
directly in the relevant plugin files.
