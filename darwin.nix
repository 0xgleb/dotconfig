{
  pkgs,
  self,
  inputs,
  userConfig,
  ...
}:
{
  system = {
    primaryUser = "0xgleb";
    stateVersion = 4;
    configurationRevision = self.rev or self.dirtyRev or null;
  };

  networking.hostName = "darwwwin";

  age.identityPaths = [
    "${userConfig.home}/.config/agenix/piece-of-pi.txt"
  ];
  age.secrets.metagenda-telegram-token.file = inputs.self + /secrets/metagenda-telegram-token.age;
  age.secrets.metagenda-telegram-token.owner = userConfig.name;

  nix.enable = true;
  nix.package = pkgs.nix;

  nixpkgs.hostPlatform = "aarch64-darwin";
  nixpkgs.config.allowUnfree = true;
  nixpkgs.overlays = [
    (import ./obsidian-overlay.nix)
    (_final: prev: {
      atuin = prev.atuin.overrideAttrs (old: {
        checkFlags = old.checkFlags ++ [
          # Upstream Darwin capture-test workaround.
          # https://github.com/NixOS/nixpkgs/issues/573527#issuecomment-6144195587
          "--skip=filtered_commands_leave_no_captured_output"
          # Pi liveness reads the host process table, which Darwin's build sandbox
          # does not isolate. A running Pi can make these synthetic sessions live.
          "--skip=a_session_gone_on_with_elsewhere_catches_up_where_it_came_from::agent_2_Agent__Pi"
          "--skip=a_diverged_copy_resumes_only_as_chosen::agent_3_Agent__Pi"
        ];
      });
      # The pinned 6.0.2 pnpm dependency fetch has an incorrect Darwin hash.
      typescript-language-server = prev.typescript-language-server.overrideAttrs (old: {
        pnpmDeps = old.pnpmDeps.overrideAttrs {
          outputHash = "sha256-PmyJb8090pEPc09Tbv8RgdvQpzpba2L8ve87+aVncQU=";
        };
      });
    })
  ];

  ids.gids.nixbld = 350;

  users = {
    knownUsers = [ userConfig.name ];
    users = {
      root.shell = pkgs.nushell;

      "${userConfig.name}" = {
        uid = 501;
        home = userConfig.home;
        shell = pkgs.nushell;
      };
    };
  };

  environment.shells = [ pkgs.nushell ];
  environment.systemPackages = with pkgs; [
    _1password-cli
    _1password-gui
    bat
    bottom
    lua
    obsidian
    rsync
  ];

  # Homebrew for GUI apps that don't work well with Nix on macOS
  homebrew = {
    enable = true;

    brews = [ "tkhq/tap/turnkey" ];
    casks = [
      "amethyst"
      "chatgpt"
      "coderabbit"
      "font-jetbrains-mono-nerd-font"
      "ghostty"
      "karabiner-elements"
      "tailscale-app"
    ];

    onActivation = {
      autoUpdate = true;
      upgrade = true;
      cleanup = "uninstall";
      # Homebrew 4.x+ rejects `brew bundle --cleanup` unless a force flag is
      # given, since cleanup uninstalls formulae. nix-darwin runs activation
      # non-interactively, so perform the cleanup without the confirmation prompt.
      extraFlags = [ "--force-cleanup" ];
    };
  };

  fonts.packages = with pkgs.nerd-fonts; [
    fira-mono
    fira-code
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
