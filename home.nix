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
  };

  programs = {
    home-manager.enable = true;

    # Git config (NOT available at system level in nix-darwin)
    git = {
      enable = true;
      settings = {
        user.name = "0xgleb";
        init.defaultBranch = "main";
        push.autoSetupRemote = true;
      };
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

    # Neovim + AstroNvim
    neovim = {
      enable = true;
      defaultEditor = true;
      extraPackages = with pkgs; [
        gcc
        gnumake
      ];
    };

    # Nushell
    nushell.enable = true;
    nushell.configFile.source = ./nushell/config.nu;
    nushell.envFile.source = ./nushell/env.nu;

    # Zellij
    zellij.enable = true;

    # FZF
    fzf.enable = true;
    fzf.enableZshIntegration = true;

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
  };
}
