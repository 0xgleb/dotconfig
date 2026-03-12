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
        runtimeInputs = with pkgs; [ git rsync coreutils fswatch ];
        text = ''
          orgRoot="$HOME/code/st0x"
          notesRoot="$HOME/code/st0x/notes"

          short() { echo "''${1/$HOME/\~}"; }

          watch=false
          while [[ $# -gt 0 ]]; do
            case "$1" in
              --notes) notesRoot="$2"; shift 2 ;;
              --watch) watch=true; shift ;;
              *) echo "Usage: md-sync [--notes DIR] [--watch]"; exit 1 ;;
            esac
          done

          md_files() {
            git -C "$1" ls-tree -r --name-only HEAD 2>/dev/null | { grep '\.md$' || true; }
            (cd "$1" && find .local -name '*.md' 2>/dev/null) || true
          }

          undot() {
            local p="$1" result=""
            while [[ "$p" == */* ]]; do
              local seg="''${p%%/*}"
              p="''${p#*/}"
              result="$result''${seg#.}/"
            done
            echo "$result''${p#.}"
          }

          sync_repo() {
            local repoPath="$1" repoName="$2"
            [ -d "$repoPath" ] || return 0
            local repoNotes="$notesRoot/$repoName"
            mkdir -p "$repoNotes"

            while IFS= read -r file; do
              [ -z "$file" ] && continue
              local noteFile="$file"
              noteFile="''${noteFile#.local/}"
              noteFile="$(undot "$noteFile")"
              local dir="''${noteFile%/*}"
              if [ "$dir" != "$noteFile" ]; then
                mkdir -p "$repoNotes/$dir"
              fi

              local src="$repoPath/$file"
              local dst="$repoNotes/$noteFile"

              if [ ! -f "$dst" ]; then
                echo "[$(date +%H:%M:%S)] [st0x.$repoName --new--> notes] $repoName/$noteFile"
                cp "$src" "$dst"
              elif ! diff -q "$src" "$dst" > /dev/null 2>&1; then
                local adds dels
                if [ "$src" -nt "$dst" ]; then
                  adds="$(diff "$dst" "$src" 2>/dev/null | grep -c '^>' || true)"
                  dels="$(diff "$dst" "$src" 2>/dev/null | grep -c '^<' || true)"
                  echo "[$(date +%H:%M:%S)] [st0x.$repoName --+$adds,-$dels--> notes] $repoName/$noteFile"
                  cp "$src" "$dst"
                else
                  adds="$(diff "$src" "$dst" 2>/dev/null | grep -c '^>' || true)"
                  dels="$(diff "$src" "$dst" 2>/dev/null | grep -c '^<' || true)"
                  echo "[$(date +%H:%M:%S)] [notes --+$adds,-$dels--> st0x.$repoName] $repoName/$noteFile"
                  cp "$dst" "$src"
                fi
              fi
            done < <(md_files "$repoPath")
          }

          repos=(liquidity issuance rest.api)

          declare -A sync_targets
          for repo in "''${repos[@]}"; do
            sync_targets["$repo"]="$orgRoot/st0x.$repo"
          done
          for repo in "''${repos[@]}"; do
            wtDir="$orgRoot/st0x.$repo/.worktrees"
            [ -d "$wtDir" ] || continue
            for wt in "$wtDir"/*/; do
              [ -d "$wt/.git" ] || [ -f "$wt/.git" ] || continue
              wtName="''${wt%/}"
              wtName="$repo/worktrees/''${wtName##*/}"
              sync_targets["$wtName"]="''${wt%/}"
            done
            for wt in "$wtDir"/*/*/; do
              [ -d "$wt/.git" ] || [ -f "$wt/.git" ] || continue
              wtName="''${wt%/}"
              wtName="$repo/worktrees/''${wtName##*/}"
              sync_targets["$wtName"]="''${wt%/}"
            done
          done

          sync_all() {
            for name in "''${!sync_targets[@]}"; do
              sync_repo "''${sync_targets[$name]}" "$name"
            done
          }

          sync_all

          if [ "$watch" = true ]; then
            echo "watching for changes..."
            watchPaths=("$notesRoot")
            for repo in "''${repos[@]}"; do
              watchPaths+=("$orgRoot/st0x.$repo")
            done

            repo_for_path() {
              local path="$1"
              if [[ "$path" == "$notesRoot/"* ]]; then
                local rel="''${path#"$notesRoot"/}"
                for name in "''${!sync_targets[@]}"; do
                  if [[ "$rel" == "$name/"* ]] || [[ "$rel" == "$name" ]]; then
                    echo "$name"
                    return
                  fi
                done
                return
              fi
              local best="" bestLen=0
              for name in "''${!sync_targets[@]}"; do
                local tp="''${sync_targets[$name]}"
                if [[ "$path" == "$tp/"* ]] && [ ''${#tp} -gt "$bestLen" ]; then
                  best="$name"
                  bestLen=''${#tp}
                fi
              done
              echo "$best"
            }

            parse_path() { echo "''${1%% *}"; }

            fswatch -l 3 -x \
              --exclude='\.git' --exclude='\.obsidian' --include='\.md$' --exclude='.*' \
              "''${watchPaths[@]}" | while read -r changed; do
              echo "[$(date +%H:%M:%S)] fswatch: $(short "$changed")"
              declare -A touched_repos
              path=$(parse_path "$changed")
              repo=$(repo_for_path "$path")
              if [ -n "$repo" ]; then
                touched_repos["$repo"]=1
              fi
              while read -r -t 0.1 extra; do
                echo "[$(date +%H:%M:%S)] fswatch: $(short "$extra")"
                path=$(parse_path "$extra")
                repo=$(repo_for_path "$path")
                if [ -n "$repo" ]; then
                  touched_repos["$repo"]=1
                fi
              done
              for name in "''${!touched_repos[@]}"; do
                echo "[$(date +%H:%M:%S)] syncing $name..."
                sync_repo "''${sync_targets[$name]}" "$name"
              done
              unset touched_repos
            done
          fi
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
