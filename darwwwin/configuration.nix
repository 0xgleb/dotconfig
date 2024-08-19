self@{ pkgs, ... }: {
  users.users."0xgleb" = {
    home = "/Users/0xgleb";
    shell = pkgs.zsh;
  };

  # Create /etc/zshrc that loads the nix-darwin environment.
  programs.zsh.enable = true;
  programs.direnv.enable = true;
  programs.vim.enable = true;
  programs.vim.enableSensible = true;

  # homebrew = {
  #   enable = true;

  #   onActivation = {
  #     autoUpdate = true;
  #     cleanup = "zap";
  #     upgrade = true;
  #   };

  #   brews = [ "emacs-mac" ];
  #   casks = [ "emacs-mac" ];
  #   taps = [ "railwaycat/emacsmacport" ];
  # };

  # List packages installed in system profile. To search by name, run:
  # $ nix-env -qaP | grep wget
  environment.systemPackages = with pkgs; [
    bat
    nil
    nixfmt-classic
    emacs
    magic-wormhole
    ripgrep
    openssl
    zellij
    spotify
    telegram-desktop
    _1password
    htop
    fzf
    obsidian
    iterm2
    tldr
    git
    gh
    jq
  ];

  # Auto upgrade nix package and the daemon service.
  services.nix-daemon.enable = true;
  nix.package = pkgs.nix;

  # Necessary for using flakes on this system.
  nix.settings.experimental-features = "nix-command flakes";

  # Set Git commit hash for darwin-version.
  system.configurationRevision = self.rev or self.dirtyRev or null;

  # Used for backwards compatibility, please read the changelog before changing.
  # $ darwin-rebuild changelog
  system.stateVersion = 4;

  # The platform the configuration will be used on.
  nixpkgs.hostPlatform = "x86_64-darwin";
  nixpkgs.config.allowUnfree = true;
}
