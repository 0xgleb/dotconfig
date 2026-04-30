{
  description = "DarWwWin + NixOS (uninix shared modules)";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    nixpkgs-unstable.url = "github:NixOS/nixpkgs/nixos-unstable";

    nix-darwin.url = "github:LnL7/nix-darwin";
    nix-darwin.inputs.nixpkgs.follows = "nixpkgs";

    home-manager.url = "github:nix-community/home-manager";
    home-manager.inputs.nixpkgs.follows = "nixpkgs";

    disko.url = "github:nix-community/disko";
    disko.inputs.nixpkgs.follows = "nixpkgs";

    nix-doom-emacs-unstraightened.url = "github:marienz/nix-doom-emacs-unstraightened";
    nix-doom-emacs-unstraightened.inputs.nixpkgs.follows = "nixpkgs";
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
                  ./home.nix
                ];
              };
          }
        ];
      };

      packages.aarch64-darwin = import ./packages.nix {
        pkgs = import nixpkgs {
          system = "aarch64-darwin";
          config.allowUnfree = true;
        };
      };

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

                echo "validating sync-daemon.nu parses..."
                cp ${./nushell/scripts/fj/md/sync-lib.nu} sync-lib.nu
                cp ${./nushell/scripts/fj/md/sync-daemon.nu} sync-daemon.nu
                ${pkgs.nushell}/bin/nu --ide-check 0 sync-daemon.nu
                echo "sync-daemon.nu parses ok"

                cp ${./nushell/scripts/fj/md/sync-lib.test.nu} sync-lib.test.nu
                ${pkgs.nushell}/bin/nu sync-lib.test.nu
                touch $out
              '';

          fj-workflow =
            pkgs.runCommand "fj-workflow-test"
              {
                nativeBuildInputs = with pkgs; [ nushell ];
              }
              ''
                cp ${./nushell/scripts/fj/workflow.test.nu} workflow.test.nu
                ${pkgs.nushell}/bin/nu workflow.test.nu
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

                echo "validating mdup.nu parses..."
                cp ${./nushell/scripts/fj/md/sync-lib.nu} sync-lib.nu
                cp ${./nushell/scripts/fj/md/lib.nu} lib.nu
                cp ${./nushell/scripts/fj/md/mdup.nu} mdup.nu
                ${pkgs.nushell}/bin/nu --ide-check 0 mdup.nu
                echo "mdup.nu parses ok"

                cp ${./nushell/scripts/fj/md/lib.test.nu} lib.test.nu
                ${pkgs.nushell}/bin/nu lib.test.nu
                touch $out
              '';
        };

      formatter.aarch64-darwin = (import nixpkgs { system = "aarch64-darwin"; }).nixfmt;

      # Expose package set for convenience
      darwinPackages = self.darwinConfigurations.darwwwin.pkgs;
    };
}
