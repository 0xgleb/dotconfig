{
  pkgs,
  lib,
  config,
  inputs,
  ...
}:

let
  nuConfigDir =
    if pkgs.stdenv.isDarwin && !config.xdg.enable then
      "Library/Application Support/nushell"
    else
      "${config.xdg.configHome}/nushell";
in
{
  imports = [ inputs.nix-doom-emacs-unstraightened.homeModule ];

  home = {
    stateVersion = "24.05";

    packages = with pkgs; [
      # CLI tools
      bat
      bottom
      dust
      htop
      jq
      magic-wormhole
      fastfetch
      tldr
      tree
      wget
      mprocs

      # Git
      gh
      gitui
      git-lfs
      git-extras

      # Dev tools
      nodejs_24
      bacon
      cargo-watch
      fswatch

      # AI
      ollama

      # Security
      gnupg
      openssl
      rage
    ];

    sessionVariables.EDITOR = "nvim";

    shellAliases = {
      l = "ls -GAlh";
      vi = "nvim";
      vim = "nvim";
    };

    shell.enableNushellIntegration = true;
    file."${nuConfigDir}/scripts".source = ../../nushell/scripts;
  };

  programs = {
    home-manager.enable = true;

    nushell = {
      enable = true;
      envFile.source = ../../nushell/env.nu;
      configFile.source = ../../nushell/config.nu;

      plugins = with pkgs.nushellPlugins; [
        polars
        query
      ];
    };

    zellij.enable = true;

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
        gcc
        lazygit
        lua-language-server
        luarocks
        nodePackages.svelte-language-server
        nodePackages.typescript-language-server
        rust-analyzer
        tree-sitter
      ];
    };

    atuin.enable = true;
    atuin.enableNushellIntegration = true;

    carapace.enable = true;
    carapace.enableNushellIntegration = true;

    zoxide.enable = true;
    zoxide.enableNushellIntegration = true;
    zoxide.enableZshIntegration = true;

    direnv.enable = true;
    direnv.nix-direnv.enable = true;
    direnv.config.global.hide_env_diff = true;

    fzf.enable = true;
    fzf.enableZshIntegration = true;

    doom-emacs = {
      enable = true;
      doomDir = ../../doom;
      emacs = if pkgs.stdenv.isDarwin then pkgs.emacs-macport else pkgs.emacs;
    };

    zsh =
      let
        zshCustom = pkgs.stdenv.mkDerivation {
          name = "zsh-custom";
          src = ../../.;
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
