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
            home-manager.useUserPackages = true;
            home-manager.backupFileExtension = "home.bak";
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

      # Helper scripts
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

          ralphUp = pkgs.writeShellApplication {
            name = "ralph-up";
            runtimeInputs = [
              pkgs.terraform
              pkgs.openssh
            ];
            text = ''
              flakeDir="$HOME/.config"
              tfDir="$flakeDir/darwwwin/terraform"
              sshKey="$HOME/.ssh/ralph_ed25519"
              dropletSize="''${1:-s-2vcpu-4gb}"
              cd "$tfDir"
              terraform init -upgrade
              terraform apply -var "droplet_size=$dropletSize" -auto-approve
              ip=$(terraform output -raw ip)
              echo "Waiting for SSH..."
              until ssh -i "$sshKey" \
                -o ConnectTimeout=5 \
                -o StrictHostKeyChecking=accept-new \
                root@"$ip" true 2>/dev/null; do sleep 2; done
              echo "Installing NixOS..."
              nix run github:nix-community/nixos-anywhere -- \
                --flake "$flakeDir#nixxxos" \
                --ssh-option "IdentityFile=$sshKey" \
                --target-host root@"$ip"
              echo "Done! ssh -i $sshKey 0xgleb@$ip"
            '';
          };

          ralphDown = pkgs.writeShellApplication {
            name = "ralph-down";
            runtimeInputs = [ pkgs.terraform ];
            text = ''
              tfDir="$HOME/.config/darwwwin/terraform"
              cd "$tfDir"
              terraform destroy -auto-approve
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

          stop-check =
            pkgs.runCommand "stop-check-test"
              {
                nativeBuildInputs = with pkgs; [
                  nushell
                  git
                ];
              }
              ''
                export HOME=$(mktemp -d)
                git config --global user.email "test@test.com"
                git config --global user.name "test"

                echo "validating stop-check.nu parses..."
                cp ${./ai/hooks/stop-check.nu} stop-check.nu
                ${pkgs.nushell}/bin/nu --ide-check 0 stop-check.nu
                echo "stop-check.nu parses ok"

                cp ${./ai/hooks/stop-check.test.nu} stop-check.test.nu
                ${pkgs.nushell}/bin/nu stop-check.test.nu
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

      # Expose package set for convenience
      darwinPackages = self.darwinConfigurations.darwwwin.pkgs;
    };
}
