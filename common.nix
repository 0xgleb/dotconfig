{ pkgs, lib, inputs, ... }:
let
  unstable = import inputs.nixpkgs-unstable {
    system = pkgs.system;
    config.allowUnfree = true;
  };
in {
  environment.systemPackages = with pkgs; [
    # CLI tools
    autojump
    bat
    bottom
    fzf
    fd
    jq
    magic-wormhole
    fastfetch
    oh-my-zsh
    ripgrep
    tldr
    wget

    # windows in terminals?
    zellij
    mprocs
    htop
    dust

    # Git
    gh
    git
    git-lfs
    git-extras
    unstable.graphite-cli

    # Dev tools
    nodejs_24
    bacon
    docker
    fswatch

    # AI
    codex
    unstable.claude-code
    ollama
    opencode

    # Nix tools
    nil
    nixd
    nixfmt-classic

    # Security
    gnupg
    openssl
    rage

    # Editors
    vim-full
  ];

  programs.zsh.enable = true;
  programs.direnv.enable = true;

  environment = {
    variables = { EDITOR = "vim"; };
    shellAliases = {
      l = if pkgs.stdenv.isDarwin then "ls -GAlh" else "ls -Alh --color=auto";
    };
    shells = [ pkgs.zsh ];
  };

  nix.settings = {
    experimental-features = "nix-command flakes";
    trusted-users = [ "0xgleb" ];
    substituters = [ "https://cache.nixos.org" ];
    trusted-public-keys =
      [ "cache.nixos.org-1:6NCHdD59X431o0gWypbMrAURkbJ16ZPMQFGspcDShjY=" ];
  };
}
