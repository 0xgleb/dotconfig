{
  description = "DarWwWin";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    nixpkgs-unstable.url = "github:NixOS/nixpkgs/nixos-unstable";

    nix-darwin.url = "github:LnL7/nix-darwin";
    nix-darwin.inputs.nixpkgs.follows = "nixpkgs";

    home-manager.url = "github:nix-community/home-manager";
    home-manager.inputs.nixpkgs.follows = "nixpkgs";

    nix-doom-emacs-unstraightened.url = "github:marienz/nix-doom-emacs-unstraightened";
    nix-doom-emacs-unstraightened.inputs.nixpkgs.follows = "nixpkgs";
  };

  outputs =
    inputs@{
      self,
      nixpkgs,
      nix-darwin,
      home-manager,
      ...
    }:
    {
      darwinConfigurations.darwwwin = nix-darwin.lib.darwinSystem {
        specialArgs = { inherit inputs self; };
        modules = [
          ./xin/common.nix
          ./xin/darwin.nix
          ./xin/users/gleb.nix
          ./xin/users/root.nix
          home-manager.darwinModules.home-manager
          {
            home-manager.useGlobalPkgs = true;
            home-manager.useUserPackages = true;
            home-manager.backupFileExtension = "home.bak";
            home-manager.extraSpecialArgs = { inherit inputs; };
            home-manager.users."0xgleb" = ./xin/users/home.nix;
          }
        ];
      };

      packages.aarch64-darwin =
        let
          pkgs = import nixpkgs {
            system = "aarch64-darwin";
            config.allowUnfree = true;
          };
        in
        {
          mdSync =
            let
              scriptDir = pkgs.runCommand "md-sync-scripts" { } ''
                mkdir -p $out
                cp ${./nushell/scripts/fj/md/sync-lib.nu} $out/sync-lib.nu
                cp ${./nushell/scripts/fj/md/sync-daemon.nu} $out/sync-daemon.nu
              '';
            in
            pkgs.writeShellApplication {
              name = "md-sync";
              runtimeInputs = with pkgs; [
                git
                fswatch
                nushell
                diffutils
              ];
              text = ''
                exec ${pkgs.nushell}/bin/nu ${scriptDir}/sync-daemon.nu "$@"
              '';
            };

          mdup =
            let
              scriptDir = pkgs.runCommand "mdup-scripts" { } ''
                mkdir -p $out
                cp ${./nushell/scripts/fj/md/sync-lib.nu} $out/sync-lib.nu
                cp ${./nushell/scripts/fj/md/lib.nu} $out/lib.nu
                cp ${./nushell/scripts/fj/md/mdup.nu} $out/mdup.nu
              '';
            in
            pkgs.writeShellApplication {
              name = "mdup";
              runtimeInputs = with pkgs; [
                bat
                deno
                git
                nushell
                diffutils
              ];
              text = ''
                exec ${pkgs.nushell}/bin/nu ${scriptDir}/mdup.nu "$@"
              '';
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
                  nushell
                  git
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

      darwinPackages = self.darwinConfigurations.darwwwin.pkgs;
    };
}
