{
  description = "DarWwWin + NixOS (uninix shared modules)";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    nixpkgs-unstable.url = "github:NixOS/nixpkgs/nixos-unstable";

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

    git-hooks.url = "github:cachix/git-hooks.nix";
    git-hooks.inputs.nixpkgs.follows = "nixpkgs";

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
    let
      hookSystems = [
        "aarch64-darwin"
        "x86_64-linux"
      ];
      gitHooks = nixpkgs.lib.genAttrs hookSystems (
        system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
        in
        inputs.git-hooks.lib.${system}.run {
          src = self;
          package = pkgs.prek;
          configPath = ".git-hooks-config.yaml";
          hooks = {
            nixfmt.enable = true;
            denofmt = {
              enable = true;
              files = "\\.md$";
              require_serial = true;
            };
            prettier = {
              enable = true;
              excludes = [ "\\.md$" ];
              settings.configPath = "${./prettier.config.mjs}";
            };
          };
        }
      );
      fjWorkflowCheck =
        system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
        in
        pkgs.runCommand "fj-workflow-test"
          {
            nativeBuildInputs = with pkgs; [
              nushell
              git
            ];
          }
          ''
            cp ${./nushell/fj/check.nu} check.nu
            cp ${./nushell/fj/check.test.nu} check.test.nu
            cp ${./nushell/fj/log.nu} log.nu
            cp ${./nushell/fj/routing.nu} routing.nu
            cp ${./nushell/fj/workflow.nu} workflow.nu
            cp ${./nushell/fj/workflow.test.nu} workflow.test.nu
            ${pkgs.nushell}/bin/nu check.test.nu
            ${pkgs.nushell}/bin/nu workflow.test.nu
            touch $out
          '';
    in
    {

      # Local macOS
      darwinConfigurations.darwwwin = nix-darwin.lib.darwinSystem {
        specialArgs = { inherit inputs self; };
        modules = [
          inputs.ragenix.darwinModules.default
          ./common.nix
          ./darwin.nix
          home-manager.darwinModules.home-manager
          {
            home-manager.useGlobalPkgs = true;
            home-manager.backupFileExtension = ".home-manager.bak";
            home-manager.extraSpecialArgs = { inherit inputs; };
            home-manager.users."0xgleb" =
              { inputs, ... }:
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
              { inputs, ... }:
              {
                imports = [
                  inputs.nix-doom-emacs-unstraightened.homeModule
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
          };
        in
        {
          jf = import ./nushell/jf.nix {
            inherit pkgs;
            metagendaFj = pkgs.callPackage ./nushell/fj/portable { };
          };
        }
        // import ./infra { inherit pkgs inputs; };

      checks.aarch64-darwin =
        let
          pkgs = import nixpkgs {
            system = "aarch64-darwin";
            config.allowUnfree = true;
          };
          atuinFlags =
            self.darwinConfigurations.darwwwin.config.home-manager.users."0xgleb".programs.atuin.flags;
          piExtensionPackage = nixpkgs.lib.importJSON ./ai/pi/extensions/package.json;
          piExtensionLock = nixpkgs.lib.importJSON ./ai/pi/extensions/package-lock.json;
          piTestPackage = piExtensionPackage // {
            devDependencies = {
              inherit (piExtensionPackage.devDependencies) "@earendil-works/pi-tui";
            };
          };
          # Stub SDK registration only; HUD tests use the pinned real TUI package.
          piTestNodeModules = pkgs.importNpmLock.buildNodeModules {
            npmRoot = ./ai/pi/extensions;
            package = piTestPackage;
            packageLock = piExtensionLock // {
              packages = piExtensionLock.packages // {
                "" = piExtensionLock.packages."" // {
                  inherit (piTestPackage) devDependencies;
                };
              };
            };
            inherit (pkgs) nodejs;
            derivationArgs.npmInstallFlags = "--legacy-peer-deps";
          };
        in
        {
          git-hooks = gitHooks.aarch64-darwin;

          obsidian-packaging =
            let
              obsidian = self.legacyPackages.aarch64-darwin.obsidian;
            in
            pkgs.runCommand "obsidian-packaging-test" { } ''
              test -x ${obsidian}/Applications/Obsidian.app/Contents/MacOS/Obsidian
              test -x ${obsidian}/Applications/Obsidian.app/Contents/MacOS/obsidian-cli
              test -x ${obsidian}/bin/obsidian
              test -x ${obsidian}/bin/obsidian-cli
              touch "$out"
            '';

          local-pi-consumer =
            assert import ./scripts/local-pi-consumer.test.nix;
            pkgs.runCommand "local-pi-consumer-test" { } ''
              touch "$out"
            '';

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

          fj-workflow = fjWorkflowCheck "aarch64-darwin";

          fj-consumer = import ./nushell/jf-consumer.test.nix {
            inherit pkgs;
            metagendaFj = pkgs.callPackage ./nushell/fj/portable { };
          };

          fj-module =
            pkgs.runCommand "fj-module-test"
              {
                nativeBuildInputs = with pkgs; [
                  nushell
                  git
                ];
              }
              ''
                mkdir nushell
                cp -r ${./nushell/fj} nushell/fj
                cp ${./nushell/jf.nix} nushell/jf.nix
                cd nushell/fj
                ${pkgs.nushell}/bin/nu routing.test.nu
                ${pkgs.nushell}/bin/nu mod.test.nu
                touch $out
              '';

          nushell-config =
            pkgs.runCommand "nushell-config-test"
              {
                nativeBuildInputs = with pkgs; [
                  atuin
                  nushell
                ];
              }
              ''
                export HOME=$(mktemp -d)
                mkdir -p "$HOME/.config/nushell"
                cp -r ${./nushell/fj} "$HOME/.config/nushell/fj"
                cp ${./nushell/env.src.nu} "$HOME/.config/nushell/env.src.nu"
                cp ${./nushell/config.src.nu} "$HOME/.config/nushell/config.src.nu"
                atuin init nu ${pkgs.lib.escapeShellArgs atuinFlags} > "$HOME/.config/nushell/atuin.nu"
                echo "validating nushell config sources..."
                ${pkgs.nushell}/bin/nu --commands 'source ~/.config/nushell/env.src.nu; source ~/.config/nushell/config.src.nu; source ~/.config/nushell/atuin.nu; let names = ($env.config.keybindings | get name); if (($names | uniq | length) != ($names | length)) { error make { msg: "duplicate Nushell keybinding names" } }'
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
                cp ${./nushell/fj/md-sync-lib.test.nu} md-sync-lib.test.nu
                ${pkgs.nushell}/bin/nu md-sync-lib.test.nu
                touch $out
              '';

          pi-extension-contracts =
            pkgs.runCommand "pi-extension-contracts-test"
              {
                nativeBuildInputs = with pkgs; [ nodejs ];
              }
              ''
                cp -r ${./ai} ai
                cp ${./home.nix} home.nix
                chmod -R u+w ai
                ln -s ${piTestNodeModules}/node_modules ai/pi/extensions/node_modules
                node --test \
                  ai/test/manual-reload.test.ts \
                  ai/test/runtime-version.test.ts \
                  ai/pi/extensions/classified-workflows/core.test.ts \
                  ai/pi/extensions/classified-workflows/intent-context.test.ts \
                  ai/pi/extensions/classified-workflows/manual-reload-boundary.test.ts \
                  ai/pi/extensions/control-plane/job-runtime.test.ts \
                  ai/pi/extensions/control-plane/server.test.ts \
                  ai/pi/extensions/control-plane/sqlite-job-store.test.ts \
                  ai/pi/extensions/control-plane/usage-policy.test.ts \
                  ai/pi/extensions/control-plane/throttle-activity.test.ts \
                  ai/pi/extensions/control-plane/dashboard/dashboard.test.ts \
                  ai/pi/extensions/usage-governor/core.test.ts \
                  ai/pi/extensions/usage-governor/throttle-hud.test.ts \
                  ai/pi/extensions/remote-control/telegram-resume.test.ts \
                  ai/pi/extensions/classified-workflows/loop.test.ts \
                  ai/pi/extensions/agent-registry/registration.test.ts \
                  ai/pi/extensions/agent-registry/outcome-events.test.ts \
                  ai/pi/extensions/agent-registry/paths.test.ts \
                  ai/pi/extensions/agent-registry/delivery.test.ts \
                  ai/pi/extensions/agent-registry/registry.test.ts \
                  ai/pi/extensions/agent-registry/presentation.test.ts \
                  ai/pi/extensions/agent-registry/listing.test.ts \
                  ai/pi/extensions/agent-registry/backlog-wake-controller.test.ts \
                  ai/pi/extensions/agent-registry/backlog-wake.test.ts \
                  ai/pi/extensions/agent-registry/backlog.test.ts \
                  ai/pi/extensions/remote-control/agent-identity.test.ts \
                  ai/pi/extensions/auto-reload/index.test.ts \
                  ai/pi/extensions/auto-reload/local-failures.test.ts \
                  ai/pi/extensions/classified-workflows/workflow-events.test.ts \
                  ai/pi/extensions/disk-pressure/index.test.ts \
                  ai/pi/extensions/disk-pressure/local-failures.test.ts \
                  ai/pi/extensions/disk-pressure/core.test.ts
                touch $out
              '';

          eod-scripts =
            pkgs.runCommand "eod-scripts-test"
              {
                nativeBuildInputs = with pkgs; [ nushell ];
              }
              ''
                cp -r ${./ai/skills/eod/scripts} scripts
                cd scripts

                # `source` fails on parse errors; `--ide-check` does not. This
                # catches parse errors only -- a bare `and` starting a
                # continuation line inside a closure parses fine and fails at
                # runtime, so the behavioural gate is evidence.test.nu below.
                echo "validating collect.nu parses..."
                ${pkgs.nushell}/bin/nu --commands 'source collect.nu'
                echo "collect.nu parses ok"

                ${pkgs.nushell}/bin/nu evidence.test.nu
                ${pkgs.nushell}/bin/nu report-contract.test.nu
                touch $out
              '';
        };

      checks.x86_64-linux.git-hooks = gitHooks.x86_64-linux;
      checks.x86_64-linux.fj-workflow = fjWorkflowCheck "x86_64-linux";

      devShells = nixpkgs.lib.genAttrs hookSystems (
        system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
          hooks = gitHooks.${system};
        in
        {
          default = pkgs.mkShellNoCC {
            packages = [ pkgs.nodejs ] ++ hooks.enabledPackages;
            inherit (hooks) shellHook;
          };
        }
      );

      formatter.aarch64-darwin = (import nixpkgs { system = "aarch64-darwin"; }).nixfmt;

      # Expose package set for convenience
      legacyPackages.aarch64-darwin = self.darwinConfigurations.darwwwin.pkgs;
    };
}
