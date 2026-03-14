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

  # macOS-specific packages
  environment.systemPackages = with pkgs; [
    brave
    obsidian
    _1password-gui
    fswatch
    rsync
  ];

  # nix-darwin specific zsh options
  programs.zsh = {
    enableFzfGit = true;
    enableFzfHistory = true;
    enableFzfCompletion = true;
  };

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
      "karabiner-elements"
    ];
  };

  # Ollama service for local LLM inference
  # TODO: add oneshot agent to pull models automatically (qwen3:32b)
  launchd.user.agents.ollama = {
    serviceConfig = {
      ProgramArguments = [
        "${pkgs.ollama}/bin/ollama"
        "serve"
      ];
      KeepAlive = true;
      RunAtLoad = true;
      EnvironmentVariables = {
        OLLAMA_ORIGINS = "*";
      };
    };
  };

  launchd.user.agents.mdaemon = {
    serviceConfig = {
      StandardErrorPath = "${userConfig.home}/Library/Logs/mdaemon.err";
      StandardOutPath = "${userConfig.home}/Library/Logs/mdaemon.out";
      ProgramArguments = [
        "${self.packages.aarch64-darwin.mdSync}/bin/md-sync"
        "--watch"
      ];

      KeepAlive = true;
      RunAtLoad = true;
    };
  };

  # Workaround for nix-darwin #1255: launchctl load/unload runs as root,
  # targeting the system domain instead of the user domain. User agents
  # don't actually restart on darwin-rebuild switch without this.
  system.activationScripts.postActivation.text = ''
    sudo -u ${userConfig.name} launchctl \
      kickstart -k "gui/$(id -u ${userConfig.name})/org.nixos.mdaemon" \
        2>/dev/null || true
  '';

}
