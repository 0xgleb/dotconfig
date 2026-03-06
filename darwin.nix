{ pkgs, lib, self, inputs, ... }: {
  nixpkgs.hostPlatform = "aarch64-darwin";
  nixpkgs.config.allowUnfree = true;

  ids.gids.nixbld = 350;

  users.users."0xgleb" = {
    home = "/Users/0xgleb";
    shell = pkgs.zsh;
  };

  # macOS-specific packages
  environment.systemPackages = with pkgs; [
    emacs-macport
    brave
    obsidian
    _1password-gui
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

  networking.hostName = "darwwwin";

  nix.enable = true;
  nix.package = pkgs.nix;

  system.primaryUser = "0xgleb";
  system.stateVersion = 4;
  system.configurationRevision = self.rev or self.dirtyRev or null;
}
