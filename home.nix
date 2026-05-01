{
  pkgs,
  lib,
  inputs,
  config,
  ...
}:

let
  jf = import ./nushell/jf.nix { inherit pkgs; };
  isDarwin = pkgs.stdenv.isDarwin;
  nuConfigDir =
    if isDarwin && !config.xdg.enable then
      "Library/Application Support/nushell"
    else
      "${config.xdg.configHome}/nushell";

  darwinFiles = {
    ".config/nushell/config.nu".source =
      config.lib.file.mkOutOfStoreSymlink "${config.home.homeDirectory}/Library/Application Support/nushell/config.nu";
    ".config/nushell/env.nu".source =
      config.lib.file.mkOutOfStoreSymlink "${config.home.homeDirectory}/Library/Application Support/nushell/env.nu";
    "Library/Application Support/com.mitchellh.ghostty/config.ghostty".source =
      ./ghostty/config.ghostty;
  };

in
{
  home = {
    username = "0xgleb";
    stateVersion = "24.05";

    packages =
      let
        unstable = import inputs.nixpkgs-unstable {
          system = pkgs.stdenv.hostPlatform.system;
          config.allowUnfree = true;
        };

      in
      (with pkgs; [
        cargo-watch
        unstable.graphite-cli

        unstable.codex
        unstable.claude-code

        jf
      ]);

    shell.enableNushellIntegration = true;
    file = {
      "${nuConfigDir}/scripts".source = ./nushell/scripts;
    }
    // lib.optionalAttrs isDarwin darwinFiles;
  };

  # NOTE: this shit doesn't clean up after itself if you enable/disable it
  # services.ollama.enable = false;

  programs = {
    home-manager.enable = true;

    zellij.enable = true;
    nushell = {
      enable = true;
      envFile.source = ./nushell/env.src.nu;
      configFile.source = ./nushell/config.src.nu;
      # configDir = nuDir;

      # plugins = with pkgs.nushellPlugins; [
      #   polars
      #   query
      # ];
    };

    git = {
      enable = true;
      signing.format = "openpgp";
      settings = {
        user.name = "0xgleb";
        init.defaultBranch = "master";
        push.autoSetupRemote = true;
      };
    };

    difftastic = {
      enable = true;
      git.enable = true;
      git.diffToolMode = true;
    };

    neovim = {
      enable = true;
      withRuby = false;
      withPython3 = false;
      extraPackages = with pkgs; [
        fd
        gcc
        lazygit
        lua-language-server
        luarocks
        nil
        ripgrep
        rust-analyzer
        svelte-language-server
        typescript-language-server
      ];
      plugins = with pkgs.vimPlugins; [
        (nvim-treesitter.withPlugins (grammars: [
          grammars.bash
          grammars.html
          grammars.css
          grammars.javascript
          grammars.json
          grammars.lua
          grammars.markdown
          grammars.markdown_inline
          grammars.nix
          grammars.rust
          grammars.svelte
          grammars.toml
          grammars.typescript
          grammars.yaml
        ]))
      ];
    };

    # Atuin — fuzzy history search (ctrl+r) for nushell
    # TODO: replace with a better one
    atuin.enable = true;
    atuin.enableNushellIntegration = true;

    # Carapace — completions for git, docker, gh, and hundreds more
    carapace.enable = true;
    carapace.enableNushellIntegration = true;

    # Zoxide — smart directory jumping
    zoxide.enable = true;
    zoxide.enableNushellIntegration = true;
    zoxide.enableZshIntegration = true;

    # Direnv
    direnv.enable = true;
    direnv.nix-direnv.enable = true;
    direnv.config.global.hide_env_diff = true;

    # fzf.enable = true;
    # fzf.enableZshIntegration = true;

    # Doom Emacs (managed by nix-doom-emacs-unstraightened)
    doom-emacs = {
      enable = true;
      doomDir = ./doom;
      emacs = if pkgs.stdenv.isDarwin then pkgs.emacs-macport else pkgs.emacs;
    };
    zsh =
      let
        zshCustom = pkgs.stdenv.mkDerivation {
          name = "zsh-custom";
          src = ./.;
          installPhase = ''
            mkdir -p $out/themes
            cp ./hyperzsh.zsh-theme $out/themes/
          '';
        };

      in
      {
        enable = true;
        oh-my-zsh = {
          enable = true;
          custom = "${zshCustom}";
          theme = "hyperzsh";
          plugins = [ "autojump" ];
        };

        dotDir = "${config.xdg.configHome}/.zsh";

        initContent = ''
          PROMPT='%{$fg[cyan]%}%c %{$reset_color%}➜ '
          export PATH="$PATH:/opt/homebrew/bin"
          set -o vi
          fastfetch
          eval "$(gt completion --shell zsh)"
        '';
      };
  };
}
