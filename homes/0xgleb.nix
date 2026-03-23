{
  pkgs,
  lib,
  config,
  userConfig,
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
  imports = [ ./shared.nix ];

  home = {
    username = userConfig.name;
    homeDirectory = userConfig.home;
    stateVersion = "24.05";

    packages = with pkgs; [
      cargo-watch
      ghostty-bin
    ];

    shell.enableNushellIntegration = true;
    file."${nuConfigDir}/scripts".source = ../nushell/scripts;
    file."Library/Application Support/com.mitchellh.ghostty/config.ghostty".source =
      ../ghostty/config.ghostty;
  };

  programs = {
    zellij.enable = true;

    nushell = {
      enable = true;
      envFile.source = ../nushell/env.nu;
      configFile.source = ../nushell/config.nu;

      plugins = with pkgs.nushellPlugins; [
        polars
        query
      ];
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

    atuin.enable = true;
    atuin.enableNushellIntegration = true;

    carapace.enableNushellIntegration = true;

    zoxide.enableNushellIntegration = true;
    zoxide.enableZshIntegration = true;

    fzf.enableZshIntegration = true;

    zsh =
      let
        zshCustom = pkgs.stdenv.mkDerivation {
          name = "zsh-custom";
          src = ../.;
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
