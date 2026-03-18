{ pkgs, lib, ... }:
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
  home = {
    username = "0xgleb";
    stateVersion = "24.05";

    shell.enableNushellIntegration = true;

  };

  programs = {
    home-manager.enable = true;

    # Git config (NOT available at system level in nix-darwin)
    git = {
      enable = true;
      settings = {
        user.name = "0xgleb";
        init.defaultBranch = "master";
        push.autoSetupRemote = true;
      };
    };

    difftastic.enable = true;
    difftastic.git.enable = true;
    difftastic.git.diffToolMode = true;

    # Neovim + AstroNvim
    neovim = {
      enable = true;
      # autowrapRuntimeDeps = false;
      extraPackages = with pkgs; [
        tree-sitter
        ripgrep
        lazygit
        luarocks
        gcc
        fd
        lua-language-server
        nil
        rust-analyzer
        nodePackages.typescript-language-server
        nodePackages.svelte-language-server
      ];
    };

    # Nushell
    nushell = {
      enable = true;
      configFile.source = ./nushell/config.nu;
      envFile.source = ./nushell/env.nu;
      plugins = with pkgs.nushellPlugins; [ polars query ];
    };

    # Zellij
    zellij.enable = true;

    # FZF
    fzf.enable = true;
    fzf.enableZshIntegration = true;

    # Atuin — fuzzy history search (ctrl+r) for nushell
    atuin.enable = true;
    atuin.enableNushellIntegration = true;

    # Carapace — completions for git, docker, gh, and hundreds more
    carapace.enable = true;
    carapace.enableNushellIntegration = true;

    # Zoxide — smart directory jumping (replaces autojump)
    zoxide.enable = true;
    zoxide.enableNushellIntegration = true;
    zoxide.enableZshIntegration = true;

    # Direnv
    direnv.enable = true;
    direnv.nix-direnv.enable = true;
    direnv.config.global.hide_env_diff = true;

    # Doom Emacs (managed by nix-doom-emacs-unstraightened)
    doom-emacs = {
      enable = true;
      doomDir = ./doom;
      emacs = if pkgs.stdenv.isDarwin then pkgs.emacs-macport else pkgs.emacs;
    };

    # Zsh config (portable via home-manager)
    zsh = {
      enable = true;
      oh-my-zsh = {
        enable = true;
        custom = "${zshCustom}";
        theme = "hyperzsh";
        plugins = [ "autojump" ];
      };
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
