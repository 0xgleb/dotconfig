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

  environment.systemPackages = with pkgs; [
    autojump
    bat
    lua
    bottom
    brave
    obsidian
    # ghostty
    _1password-gui
    rsync
    self.packages.aarch64-darwin.mdup
  ];

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

  launchd = {
    user.envVariables.XDG_CONFIG_HOME = "${userConfig.home}/.config";

    daemons.limit-maxfiles = {
      script = "launchctl limit maxfiles 524288 524288";
      serviceConfig = {
        RunAtLoad = true;
        LaunchOnlyOnce = true;
      };
    };
  };
}
