{ pkgs, ... }:
let
  # User configuration (source of truth)
  user = {
    name = "0xgleb";
    home = "/Users/0xgleb";
  };
in
{
  # Export for use in other modules
  _module.args.userConfig = user;

  # programs.zsh.enable = true;
  # programs.direnv.enable = true;

  environment = {
    # etc."nushell/config.nu".source = ./nushell/config.nu;
    # etc."nushell/env.nu".source = ./nushell/env.nu;
    # etc."nushell/fix-worktree-submodules.nu".source = ./nushell/fix-worktree-submodules.nu;
    shells = [
      pkgs.zsh
      pkgs.nushell
    ];

    variables.EDITOR = "nvim";
    shellAliases = {
      l = "ls -GAlh";
      vi = "nvim";
      vim = "nvim";
    };

    systemPackages = with pkgs; [
      # CLI tools
      fzf
      fd
      jq
      magic-wormhole
      fastfetch
      # oh-my-zsh
      ripgrep
      tldr
      tree
      wget

      # windows in terminals?
      zellij
      mprocs
      htop
      dust

      # Git
      gh
      git
      gitui
      git-lfs
      git-extras

      # Dev tools
      nodejs_24
      bacon
      fswatch

      # # AI
      opencode
      ollama

      # Nix tools
      nil
      nixd
      nixfmt

      # Security
      gnupg
      openssl
      rage
    ];
  };

  nix.settings = {
    experimental-features = "nix-command flakes";
    trusted-users = [ "0xgleb" ];
    substituters = [ "https://cache.nixos.org" ];
    trusted-public-keys = [
      "cache.nixos.org-1:6NCHdD59X431o0gWypbMrAURkbJ16ZPMQFGspcDShjY="
    ];
  };
}
