{
  description = "DarWwWin + NixOS (uninix shared modules)";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    nixpkgs-unstable.url = "github:NixOS/nixpkgs/nixos-unstable";

    # Pins the Claude Code release manifest so we can track Anthropic's prebuilt
    # binaries ahead of nixpkgs. Bump the version in this URL and run
    # `nix flake update claude-code-manifest` to upgrade.
    claude-code-manifest = {
      url = "https://downloads.claude.ai/claude-code-releases/2.1.214/manifest.json";
      flake = false;
    };

    nix-darwin.url = "github:LnL7/nix-darwin";
    nix-darwin.inputs.nixpkgs.follows = "nixpkgs";

    home-manager.url = "github:nix-community/home-manager";
    home-manager.inputs.nixpkgs.follows = "nixpkgs";

    ragenix.url = "github:yaxitech/ragenix";
    ragenix.inputs.nixpkgs.follows = "nixpkgs";

    disko.url = "github:nix-community/disko";
    disko.inputs.nixpkgs.follows = "nixpkgs";

    # Pinned (via flake.lock) so `provision` installs with a known nixos-anywhere
    # instead of refetching tip-of-tree on every run.
    nixos-anywhere.url = "github:nix-community/nixos-anywhere";
    nixos-anywhere.inputs.nixpkgs.follows = "nixpkgs";

    nix-doom-emacs-unstraightened.url = "github:marienz/nix-doom-emacs-unstraightened";
    nix-doom-emacs-unstraightened.inputs.nixpkgs.follows = "nixpkgs";

    but-nix.url = "github:data-cartel/but.nix";
    but-nix.inputs.nixpkgs.follows = "nixpkgs";
  };

  outputs =
    inputs@{
      self,
      nixpkgs,
      nix-darwin,
      home-manager,
      disko,
      ...
    }:
    {

      # Local macOS
      darwinConfigurations.darwwwin = nix-darwin.lib.darwinSystem {
        specialArgs = { inherit inputs self; };
        modules = [
          ./common.nix
          ./darwin.nix
          home-manager.darwinModules.home-manager
          {
            home-manager.useGlobalPkgs = true;
            home-manager.backupFileExtension = ".home-manager.bak";
            home-manager.extraSpecialArgs = { inherit inputs; };
            home-manager.users."0xgleb" =
              { pkgs, inputs, ... }:
              {
                imports = [
                  inputs.nix-doom-emacs-unstraightened.homeModule
                  inputs.ragenix.homeManagerModules.default
                  ./home.nix
                ];
              };
          }
        ];
      };

      # Remote NixOS on Digital Ocean
      nixosConfigurations.nixxxos = nixpkgs.lib.nixosSystem {
        system = "x86_64-linux";
        specialArgs = { inherit inputs; };
        modules = [
          ./common.nix
          ./nixos.nix
          ./digitalocean.nix
          disko.nixosModules.disko
          home-manager.nixosModules.home-manager
          {
            home-manager.useGlobalPkgs = true;
            home-manager.useUserPackages = true;
            home-manager.extraSpecialArgs = { inherit inputs; };
            home-manager.users."0xgleb" =
              { pkgs, inputs, ... }:
              {
                imports = [
                  inputs.nix-doom-emacs-unstraightened.homeModule
                  inputs.ragenix.homeManagerModules.default
                  ./home.nix
                ];
              };
          }
        ];
      };

      packages.aarch64-darwin =
        let
          pkgs = import nixpkgs {
            system = "aarch64-darwin";
            config.allowUnfree = true;
            overlays = [ (import ./graphite-cli-overlay.nix) ];
          };
        in
        {
          jf = import ./nushell/jf.nix { inherit pkgs; };
        }
        // import ./infra { inherit pkgs inputs; };

      checks.aarch64-darwin =
        let
          pkgs = import nixpkgs {
            system = "aarch64-darwin";
            config.allowUnfree = true;
          };
        in
        {
          md-sync =
            pkgs.runCommand "md-sync-test"
              {
                nativeBuildInputs = with pkgs; [
                  git
                  nushell
                  diffutils
                ];
              }
              ''
                export HOME=$(mktemp -d)
                git config --global user.email "test@test.com"
                git config --global user.name "test"

                echo "validating md-sync-daemon.nu parses..."
                cp ${./nushell/fj/md-sync-lib.nu} md-sync-lib.nu
                cp ${./nushell/fj/md-sync-daemon.nu} md-sync-daemon.nu
                # `source` fails on parse errors; `--ide-check` does not (it
                # prints diagnostics but exits 0, so it never gates the build).
                ${pkgs.nushell}/bin/nu --commands 'source md-sync-daemon.nu'
                echo "md-sync-daemon.nu parses ok"

                cp ${./nushell/fj/md-sync-lib.test.nu} md-sync-lib.test.nu
                ${pkgs.nushell}/bin/nu md-sync-lib.test.nu
                touch $out
              '';

          fj-workflow =
            pkgs.runCommand "fj-workflow-test"
              {
                nativeBuildInputs = with pkgs; [ nushell ];
              }
              ''
                cp ${./nushell/fj/workflow.test.nu} workflow.test.nu
                ${pkgs.nushell}/bin/nu workflow.test.nu
                touch $out
              '';

          fj-module =
            pkgs.runCommand "fj-module-test"
              {
                nativeBuildInputs = with pkgs; [ nushell ];
              }
              ''
                cp -r ${./nushell/fj} fj
                cd fj
                ${pkgs.nushell}/bin/nu routing.test.nu
                ${pkgs.nushell}/bin/nu mod.test.nu
                touch $out
              '';

          nushell-config =
            pkgs.runCommand "nushell-config-test"
              {
                nativeBuildInputs = with pkgs; [ nushell ];
              }
              ''
                export HOME=$(mktemp -d)
                mkdir -p "$HOME/.config/nushell"
                cp -r ${./nushell/fj} "$HOME/.config/nushell/fj"
                cp ${./nushell/env.src.nu} "$HOME/.config/nushell/env.src.nu"
                cp ${./nushell/config.src.nu} "$HOME/.config/nushell/config.src.nu"
                echo "validating nushell config sources..."
                ${pkgs.nushell}/bin/nu --commands 'source ~/.config/nushell/env.src.nu; source ~/.config/nushell/config.src.nu'
                echo "nushell config sources ok"
                touch $out
              '';

          mdup =
            pkgs.runCommand "mdup-test"
              {
                nativeBuildInputs = with pkgs; [
                  deno
                  nushell
                  git
                  diffutils
                ];
              }
              ''
                export HOME=$(mktemp -d)
                git config --global user.email "test@test.com"
                git config --global user.name "test"

                echo "validating md-mdup.nu parses..."
                cp ${./nushell/fj/md-sync-lib.nu} md-sync-lib.nu
                cp ${./nushell/fj/md-lib.nu} md-lib.nu
                cp ${./nushell/fj/md-mdup.nu} md-mdup.nu
                # `source` fails on parse errors; `--ide-check` does not.
                ${pkgs.nushell}/bin/nu --commands 'source md-mdup.nu'
                echo "md-mdup.nu parses ok"

                cp ${./nushell/fj/md-lib.test.nu} md-lib.test.nu
                ${pkgs.nushell}/bin/nu md-lib.test.nu
                touch $out
              '';
        };

      formatter.aarch64-darwin = (import nixpkgs { system = "aarch64-darwin"; }).nixfmt;

      # Expose package set for convenience
      darwinPackages = self.darwinConfigurations.darwwwin.pkgs;
    };
}
