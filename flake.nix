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
              script = pkgs.writeScriptBin "md-sync-inner" ''
                #!${pkgs.nushell}/bin/nu
                ${builtins.readFile ./mdaemon/sync-lib.nu}
                ${builtins.readFile ./mdaemon/sync.nu}
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
                exec ${script}/bin/md-sync-inner "$@"
              '';
            };

          mdup =
            let
              script = pkgs.writeScriptBin "mdup" ''
                #!${pkgs.nushell}/bin/nu
                ${builtins.readFile ./mdaemon/sync-lib.nu}
                ${builtins.readFile ./mdaemon/mdup-lib.nu}
                ${builtins.readFile ./mdaemon/mdup.nu}
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
                exec ${script}/bin/mdup "$@"
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

                echo "validating assembled script parses..."
                ${pkgs.nushell}/bin/nu --ide-check 0 \
                  ${self.packages.aarch64-darwin.mdSync}/bin/md-sync-inner
                echo "assembled script parses ok"

                cp ${./mdaemon/sync-lib.nu} sync-lib.nu
                cp ${./mdaemon/sync.test.nu} sync.test.nu
                ${pkgs.nushell}/bin/nu sync.test.nu
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

                echo "validating assembled mdup script parses..."
                ${pkgs.nushell}/bin/nu --ide-check 0 \
                  ${self.packages.aarch64-darwin.mdup}/bin/mdup
                echo "mdup script parses ok"

                cp ${./mdaemon/sync-lib.nu} sync-lib.nu
                cp ${./mdaemon/mdup-lib.nu} mdup-lib.nu
                cp ${./mdaemon/mdup.test.nu} mdup.test.nu
                ${pkgs.nushell}/bin/nu mdup.test.nu
                touch $out
              '';
        };

      # Expose package set for convenience
      darwinPackages = self.darwinConfigurations.darwwwin.pkgs;
    };
}
