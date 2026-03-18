{
  pkgs,
  lib,
  self,
  inputs,
  userConfig,
  ...
}:
{
  networking.hostName = "darwwwin";

  nix.enable = true;
  nix.package = pkgs.nix;

  system.primaryUser = "0xgleb";
  system.stateVersion = 4;
  system.configurationRevision = self.rev or self.dirtyRev or null;

  nixpkgs.hostPlatform = "aarch64-darwin";
  nixpkgs.config.allowUnfree = true;

  ids.gids.nixbld = 350;
  environment.shells = [ pkgs.nushell ];
  users.knownUsers = [ userConfig.name ];
  users.users."${userConfig.name}" = {
    uid = 501;
    home = userConfig.home;
    shell = pkgs.nushell;
  };
  users.users.root.shell = pkgs.nushell;

  # macOS-specific packages
  environment.systemPackages = with pkgs; [
    autojump
    zoxide
    bat
    lua
    ripgrep
    fd
    bottom
    brave
    obsidian
    # ghostty
    _1password-gui
    fswatch
    rsync
    self.packages.aarch64-darwin.mdup
  ];

  # home.nix should take care of this already
  # # nix-darwin specific zsh options
  # programs.zsh = {
  #   enableFzfGit = true;
  #   enableFzfHistory = true;
  #   enableFzfCompletion = true;
  # };

  # Homebrew for GUI apps that don't work well with Nix on macOS
  homebrew = {
    enable = true;
    onActivation = {
      autoUpdate = true;
      upgrade = true;
      cleanup = "uninstall";
    };
    casks = [
      "amethyst"
      "coderabbit"
      "font-jetbrains-mono-nerd-font"
      "karabiner-elements"
    ];
  };

  fonts.packages = with pkgs; [
    nerd-fonts.fira-mono
    nerd-fonts.fira-code
  ];

  launchd.daemons.limit-maxfiles = {
    script = "launchctl limit maxfiles 524288 524288";
    serviceConfig = {
      RunAtLoad = true;
      LaunchOnlyOnce = true;
    };
  };

  # launchd.user.agents.mdaemon = {
  #   serviceConfig = {
  #     StandardErrorPath = "${userConfig.home}/Library/Logs/mdaemon.err";
  #     StandardOutPath = "${userConfig.home}/Library/Logs/mdaemon.out";
  #     ProgramArguments = [
  #       "${self.packages.aarch64-darwin.mdSync}/bin/md-sync"
  #       "--watch"
  #     ];
  #
  #     KeepAlive = true;
  #     RunAtLoad = true;
  #   };
  # };

  # Symlink root's nushell config to /etc/nushell so root gets the same shell config
  # Workaround for nix-darwin #1255: kickstart user agents after activation
  system.activationScripts.postActivation.text = ''
    mkdir -p "/var/root/Library/Application Support/nushell"
    ln -sf /etc/nushell/config.nu "/var/root/Library/Application Support/nushell/config.nu"
    ln -sf /etc/nushell/env.nu "/var/root/Library/Application Support/nushell/env.nu"
    sudo -u ${userConfig.name} launchctl \
      kickstart -k "gui/$(id -u ${userConfig.name})/org.nixos.mdaemon" \
        2>/dev/null || true
  '';

}
