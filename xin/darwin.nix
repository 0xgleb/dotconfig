{
  pkgs,
  self,
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

  ids.gids.nixbld = 350;

  environment.systemPackages = with pkgs; [
    autojump
    brave
    obsidian
    _1password-gui
    rsync
    self.packages.aarch64-darwin.mdup
  ];

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
    user.envVariables.XDG_CONFIG_HOME = "$HOME/.config";

    daemons.limit-maxfiles = {
      script = "launchctl limit maxfiles 524288 524288";
      serviceConfig = {
        RunAtLoad = true;
        LaunchOnlyOnce = true;
      };
    };
  };
}
