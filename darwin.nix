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
      atuin = prev.stdenvNoCC.mkDerivation (finalAttrs: {
        pname = "atuin";
        version = "18.24.4";

        src = prev.fetchurl {
          url = "https://github.com/atuinsh/atuin/releases/download/v${finalAttrs.version}/atuin-aarch64-apple-darwin.tar.gz";
          hash = "sha256-7dBilDd1mb9NhcozN6vIAiVqmRJiJgvdmA0bZJWDVT0=";
        };

        dontFixup = true;

        installPhase = ''
          runHook preInstall
          install -Dm755 atuin "$out/bin/atuin"
          install -Dm644 LICENSE "$out/share/licenses/atuin/LICENSE"
          runHook postInstall
        '';

        nativeInstallCheckInputs = [ prev.versionCheckHook ];
        doInstallCheck = true;

        meta = prev.atuin.meta // {
          platforms = [ "aarch64-darwin" ];
          sourceProvenance = [ prev.lib.sourceTypes.binaryNativeCode ];
        };
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

    # brews = [ "tkhq/tap/turnkey" ];
    casks = [
      "amethyst"
      "chatgpt"
      # "coderabbit"
      "font-jetbrains-mono-nerd-font"
      "ghostty"
      "karabiner-elements"
      # "tailscale-app"
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
