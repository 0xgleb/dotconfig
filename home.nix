{ pkgs, lib, ... }: {
  home = {
    username = "0xgleb";
    stateVersion = "24.05";

    packages = with pkgs; [ cargo-watch ];

    shell.enableNushellIntegration = true;
    file."Library/Application Support/nushell/fix-worktree-submodules.nu".source =
      ./nushell/fix-worktree-submodules.nu;
  };

  # NOTE: this shit doesn't clean up after itself if you enable/disable it
  # services.ollama.enable = false;

  programs = {
    home-manager.enable = true;

    zellij.enable = true;
    nushell = {
      enable = true;
      configFile.source = ./nushell/config.nu;
      envFile.source = ./nushell/env.nu;
      plugins = with pkgs.nushellPlugins; [ polars query ];
    };

    git = {
      enable = true;
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
      extraPackages = with pkgs; [
        fd
        gcc
        lazygit
        lua-language-server
        luarocks
        nil
        nodePackages.svelte-language-server
        nodePackages.typescript-language-server
        ripgrep
        rust-analyzer
        tree-sitter
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

    fzf.enable = true;
    fzf.enableZshIntegration = true;

    # Doom Emacs (managed by nix-doom-emacs-unstraightened)
    doom-emacs = {
      enable = true;
      doomDir = ./doom;
      emacs = if pkgs.stdenv.isDarwin then pkgs.emacs-macport else pkgs.emacs;
    };

    zsh = let
      zshCustom = pkgs.stdenv.mkDerivation {
        name = "zsh-custom";
        src = ./.;
        installPhase = ''
          mkdir -p $out/themes
          cp ./hyperzsh.zsh-theme $out/themes/
        '';
      };

    in {
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
