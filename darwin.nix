{ pkgs, lib, self, inputs, userConfig, ... }: {
  nixpkgs.hostPlatform = "aarch64-darwin";
  nixpkgs.config.allowUnfree = true;

  ids.gids.nixbld = 350;
  users.users."${userConfig.name}" = {
    home = userConfig.home;
    shell = pkgs.zsh;
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
    casks = [ "amethyst" "coderabbit" "karabiner-elements" ];
  };

  # Ollama service for local LLM inference
  # TODO: add oneshot agent to pull models automatically (qwen3:32b)
  launchd.user.agents.ollama = {
    serviceConfig = {
      ProgramArguments = [ "${pkgs.ollama}/bin/ollama" "serve" ];
      KeepAlive = true;
      RunAtLoad = true;
      EnvironmentVariables = { OLLAMA_ORIGINS = "*"; };
    };
  };

  launchd.user.agents.syncNotes = {
    serviceConfig = {
      ProgramArguments = [ "${self.packages.aarch64-darwin.mdSync}/bin/md-sync" "--watch" ];
      KeepAlive = true;
      RunAtLoad = true;
      StandardErrorPath = "${userConfig.home}/Library/Logs/syncNotes.err";
      StandardOutPath = "${userConfig.home}/Library/Logs/syncNotes.out";
    };
  };

  networking.hostName = "darwwwin";

  nix.enable = true;
  nix.package = pkgs.nix;

  system.primaryUser = "0xgleb";
  system.stateVersion = 4;
  system.configurationRevision = self.rev or self.dirtyRev or null;
}
