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

  outputs = inputs@{ self, nixpkgs, nix-darwin, home-manager, disko, ... }: {

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
          home-manager.backupFileExtension = "hm-backup";
          home-manager.extraSpecialArgs = { inherit inputs; };
          home-manager.users."0xgleb" = { pkgs, inputs, ... }: {
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
          home-manager.users."0xgleb" = { pkgs, inputs, ... }: {
            imports = [
              inputs.nix-doom-emacs-unstraightened.homeModule
              ./home.nix
            ];
          };
        }
      ];
    };

    # Helper scripts
    packages.aarch64-darwin = let
      pkgs = import nixpkgs {
        system = "aarch64-darwin";
        config.allowUnfree = true;
      };
    in {
      mdSync = pkgs.writeShellApplication {
        name = "md-sync";
        runtimeInputs = with pkgs; [ git rsync coreutils ];
        text = ''
          orgRoot="''${MD_SYNC_ORG:-$HOME/code/st0x}"
          notesRoot="''${MD_SYNC_NOTES:-$HOME/code/st0x/notes}"
          mkdir -p "$notesRoot"

          # Get markdown files tracked by git in a repo
          md_files() {
            git -C "$1" ls-tree -r --name-only HEAD 2>/dev/null | { grep '\.md$' || true; }
          }

          # Sync one repo's markdown files into notes dir
          # Usage: sync_repo <gitPath> <repoName>
          # Result: AGENTS.md → notes/AGENTS.<repoName>.md (preserving subdirs)
          sync_repo() {
            local gitPath=$1 repoName=$2
            [ -d "$gitPath" ] || return 0
            local count=0
            while IFS= read -r file; do
              [ -z "$file" ] && continue
              local basename="''${file##*/}"
              local nameonly="''${basename%.md}"
              local dirname="''${file%/*}"
              local dest
              if [ "$dirname" = "$file" ]; then
                dest="$notesRoot/$nameonly.$repoName.md"
              else
                dest="$notesRoot/$dirname/$nameonly.$repoName.md"
              fi
              mkdir -p "''${dest%/*}"
              rsync -q "$gitPath/$file" "$dest"
              count=$((count + 1))
            done < <(md_files "$gitPath")
            echo "[$repoName] $gitPath -> $count files"
          }

          # Sync all repos
          cmd_sync() {
            for repo in liquidity issuance; do
              local repoPath="$orgRoot/st0x.$repo"
              sync_repo "$repoPath" "$repo"

              local wtDir="$repoPath/.worktrees"
              [ -d "$wtDir" ] || continue
              for wtPath in "$wtDir"/*; do
                [ -d "$wtPath" ] || continue
                sync_repo "$wtPath" "$repo"
              done
            done
          }

          case "''${1:-sync}" in
            sync) cmd_sync ;;
            *) echo "Usage: md-sync [sync]"; exit 1 ;;
          esac
        '';
      };

      ralphUp = pkgs.writeShellApplication {
        name = "ralph-up";
        runtimeInputs = [ pkgs.terraform pkgs.openssh ];
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

    # Expose package set for convenience
    darwinPackages = self.darwinConfigurations.darwwwin.pkgs;
  };
}
