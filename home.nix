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
in {
  programs.home-manager.enable = true;

  home = {
    username = "0xgleb";
    stateVersion = "24.05";
  };

  # Git config (NOT available at system level in nix-darwin)
  programs.git = {
    enable = true;
    settings = {
      user.name = "0xgleb";
      init.defaultBranch = "main";
      push.autoSetupRemote = true;
    };
  };

  # Zsh config (portable via home-manager)
  programs.zsh = {
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
    '';
  };

  # Zellij
  programs.zellij = { enable = true; };

  # FZF
  programs.fzf = {
    enable = true;
    enableZshIntegration = true;
  };

  # Direnv
  programs.direnv = {
    enable = true;
    nix-direnv.enable = true;
  };
}
