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
    brave
    obsidian
    _1password-gui
    fswatch
    rsync
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

  # Sync markdown files bidirectionally between repos and notes vault
  launchd.user.agents.syncNotes = {
    serviceConfig = {
      ProgramArguments = [
        "${pkgs.bash}/bin/bash"
        "-c"
        ''
          notesDir="$HOME/code/st0x/notes"
          st0xDir="$HOME/code/st0x"
          configDir="$HOME/.config"
          mkdir -p "$notesDir"

          # Color codes
          GREEN='\033[0;32m'
          YELLOW='\033[0;33m'
          CYAN='\033[0;36m'
          BLUE='\033[0;34m'
          RESET='\033[0m'

          sync_forward() {
            local gitPath=$1
            local outDir=$2
            [ -d "$gitPath" ] || return
            local -a synced
            while IFS= read -r file; do
              local output="$outDir/$file"
              mkdir -p "$notesDir/''${output%/*}"
              ${pkgs.rsync}/bin/rsync -q "$gitPath/$file" "$notesDir/$output"
              synced+=("$gitPath/$file → $notesDir/$output")
            done < <(git -C "$gitPath" ls-tree -r --name-only HEAD 2>/dev/null | grep '\.md$')

            if [ ''${#synced[@]} -gt 0 ]; then
              echo -e "$GREEN[$(date '+%H:%M:%S')] Forward sync: $outDir ($''${#synced[@]} files)$RESET"
              for item in "''${synced[@]}"; do
                echo -e "  $BLUE→$RESET $item"
              done
            fi
          }

          sync_reverse() {
            local gitPath=$1
            local outDir=$2
            [ -d "$gitPath" ] || return
            local -a synced
            while IFS= read -r file; do
              local notesFile="$notesDir/$outDir/$file"
              if [ -f "$notesFile" ]; then
                ${pkgs.rsync}/bin/rsync -q "$notesFile" "$gitPath/$file"
                synced+=("$notesDir/$outDir/$file → $gitPath/$file")
              fi
            done < <(git -C "$gitPath" ls-tree -r --name-only HEAD 2>/dev/null | grep '\.md$')

            if [ ''${#synced[@]} -gt 0 ]; then
              echo -e "$GREEN[$(date '+%H:%M:%S')] Reverse sync: $outDir ($''${#synced[@]} files)$RESET"
              for item in "''${synced[@]}"; do
                echo -e "  $BLUE←$RESET $item"
              done
            fi
          }

          do_sync() {
            # Main repos
            sync_forward "$st0xDir/st0x.liquidity" "liquidity"
            sync_forward "$st0xDir/st0x.issuance" "issuance"
            sync_forward "$configDir" "$(echo "$configDir" | sed 's|/||g; s|\.||g; s|^|dot|')"

            # Worktrees
            for repo in liquidity issuance; do
              local wtDir="$st0xDir/st0x.$repo/.worktrees"
              [ -d "$wtDir" ] || continue
              while IFS= read -r wtPath; do
                [ -d "$wtPath" ] || continue
                local wtName="''${wtPath%/}"
                wtName="''${wtName##*/}"
                local count=0
                local -a synced
                while IFS= read -r file; do
                  local basename="''${file##*/}"
                  local nameonly="''${basename%.md}"
                  local dirname="''${file%/*}"

                  if [ "$dirname" = "$file" ]; then
                    local output="$wtName/$nameonly.$repo.md"
                  else
                    local output="$wtName/$dirname/$nameonly.$repo.md"
                  fi

                  mkdir -p "$notesDir/''${output%/*}"
                  ${pkgs.rsync}/bin/rsync -q "$wtPath/$file" "$notesDir/$output"
                  synced+=("$wtPath/$file → $notesDir/$output")
                done < <(git -C "$wtPath" ls-tree -r --name-only HEAD 2>/dev/null | grep '\.md$')

                if [ ''${#synced[@]} -gt 0 ]; then
                  echo -e "$GREEN[$(date '+%H:%M:%S')] Forward sync: $wtName/$repo ($''${#synced[@]} files)$RESET"
                  for item in "''${synced[@]}"; do
                    echo -e "  $BLUE→$RESET $item"
                  done
                fi
              done < <(find "$wtDir" -mindepth 2 -type d -not -path '*/.git/*' | sort)
            done

            # Reverse sync
            sync_reverse "$st0xDir/st0x.liquidity" "liquidity"
            sync_reverse "$st0xDir/st0x.issuance" "issuance"
            sync_reverse "$configDir" "$(echo "$configDir" | sed 's|/||g; s|\.||g; s|^|dot|')"
          }

          echo -e "$CYAN[$(date '+%H:%M:%S')] Starting bidirectional sync service...$RESET"
          do_sync

          echo -e "$CYAN[$(date '+%H:%M:%S')] Watching for changes in repos...$RESET"
          ${pkgs.fswatch}/bin/fswatch -r "$st0xDir/st0x.liquidity" "$st0xDir/st0x.issuance" "$configDir" | while read -r file; do
            if [[ $file == *.md ]]; then
              echo -e "$YELLOW[$(date '+%H:%M:%S')] Change detected: $file$RESET"
              do_sync
            fi
          done
        ''
      ];
      KeepAlive = true;
      RunAtLoad = true;
      StandardErrorPath = "/tmp/sync-notes.err";
      StandardOutPath = "/tmp/sync-notes.out";
    };
  };

  networking.hostName = "darwwwin";

  nix.enable = true;
  nix.package = pkgs.nix;

  system.primaryUser = "0xgleb";
  system.stateVersion = 4;
  system.configurationRevision = self.rev or self.dirtyRev or null;
}
