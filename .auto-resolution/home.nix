{
  pkgs,
  lib,
  inputs,
  config,
  ...
}:

let
  jf = import ./nushell/jf.nix { inherit pkgs; };
  isDarwin = pkgs.stdenv.hostPlatform.isDarwin;
  aiDir = "${config.home.homeDirectory}/.config/ai";
  cursorDir = "${config.home.homeDirectory}/.cursor";
  piDir = "${config.home.homeDirectory}/.pi/agent";
  moveAnalyzer = pkgs.writeShellApplication {
    name = "move-analyzer";
    text = ''
      if ! command -v sui >/dev/null; then
        echo "move-analyzer requires a project dev shell that provides sui" >&2
        exit 127
      fi
      exec sui analyzer "$@"
    '';
  };
  moveTreeSitter = pkgs.vimPlugins.nvim-treesitter.grammarToPlugin pkgs.tree-sitter-grammars.tree-sitter-move;
  but-unwrapped = inputs.but-nix.packages.${pkgs.stdenv.hostPlatform.system}.gitbutler-cli;
  but = pkgs.writeShellScriptBin "but" ''
    exec ${pkgs.bash}/bin/bash ${./scripts/but-linked-worktree-guard.sh} \
      ${but-unwrapped}/bin/but "$@"
  '';
  system = pkgs.stdenv.hostPlatform.system;
  unstable = import inputs.nixpkgs-unstable {
    inherit system;
    config.allowUnfree = true;
    overlays = [ (import ./graphite-cli-overlay.nix) ];
  };
  pi-coding-agent-with-reload = unstable.pi-coding-agent.overrideAttrs (old: {
    postInstall = (old.postInstall or "") + ''
      patch -p1 -d "$out/lib/node_modules/pi-monorepo" \
        < ${./ai/pi/patches/extension-context-reload.patch}
      patch -p1 -d "$out/lib/node_modules/pi-monorepo" \
        < ${./ai/pi/patches/canvas-background.patch}
      patch -p1 -d "$out/lib/node_modules/pi-monorepo" \
        < ${./ai/pi/patches/oauth-refresh-abort.patch}
      install -Dm644 ${./ai/pi/host/request-lifecycle.js} \
        "$out/lib/node_modules/pi-monorepo/dist/core/request-lifecycle.js"
      mkdir -p "$out/lib/node_modules/pi-monorepo/node_modules/@earendil-works/pi-ai/dist/observability"
      ln -s ../../../../../dist/core/request-lifecycle.js \
        "$out/lib/node_modules/pi-monorepo/node_modules/@earendil-works/pi-ai/dist/observability/request-lifecycle.js"
      patch -p1 -d "$out/lib/node_modules/pi-monorepo" \
        < ${./ai/pi/patches/request-observability.patch}
      # GNU patch exits 0 even when it silently drops the trailing hunks
      # of a malformed section. That once installed a host whose
      # _runAgentPrompt compared string continuation states while
      # _handlePostAgentRun still returned booleans, crashing every
      # completed turn with "Cannot continue from message role:
      # assistant". Assert both sides of the contract in the artifact.
      session="$out/lib/node_modules/pi-monorepo/dist/core/agent-session.js"
      interactive="$out/lib/node_modules/pi-monorepo/dist/modes/interactive/interactive-mode.js"
      assistant_message="$out/lib/node_modules/pi-monorepo/dist/modes/interactive/components/assistant-message.js"
      wrapper="$out/lib/node_modules/pi-monorepo/dist/core/extensions/wrapper.js"
      canvas="$out/lib/node_modules/pi-monorepo/node_modules/@earendil-works/pi-tui/dist/tui.js"
      alt_screen="$out/lib/node_modules/pi-monorepo/node_modules/@earendil-works/pi-tui/dist/tui-alt-screen.js"
      main_screen="$out/lib/node_modules/pi-monorepo/node_modules/@earendil-works/pi-tui/dist/tui-main-screen.js"
      oauth_resolver="$out/lib/node_modules/pi-monorepo/node_modules/@earendil-works/pi-ai/dist/auth/resolve.js"
      model_runtime="$out/lib/node_modules/pi-monorepo/dist/core/model-runtime.js"
      auth_storage="$out/lib/node_modules/pi-monorepo/dist/core/auth-storage.js"
      codex_provider="$out/lib/node_modules/pi-monorepo/node_modules/@earendil-works/pi-ai/dist/api/openai-codex-responses.js"
      request_lifecycle="$out/lib/node_modules/pi-monorepo/dist/core/request-lifecycle.js"
      request_lifecycle_bridge="$out/lib/node_modules/pi-monorepo/node_modules/@earendil-works/pi-ai/dist/observability/request-lifecycle.js"
      grep -qF 'continuation === "none"' "$session"
      grep -qF 'return "recovery"' "$session"
      grep -qF 'return this.agent.hasQueuedMessages() ? "queued" : "none";' "$session"
      grep -qF 'pauseQueuedMessagesOnce() {' "$session"
      if ! grep -qF '_promptAdmissionTail = Promise.resolve();' "$session" ||
         ! grep -qF 'await previousAdmission;' "$session" ||
         ! grep -qF 'releaseAdmission();' "$session"; then
        echo "extension-triggered prompt admission serialization missing" >&2
        exit 1
      fi
      if [ "$(grep -cF 'await this._queueFollowUp(expandedText, currentImages);' "$session")" -ne 1 ]; then
        echo "out-of-scope prompt reconstruction survived" >&2
        exit 1
      fi
      if ! grep -qF 'restoreFailedUserInput(this.editor, userInput);' "$interactive" ||
         ! grep -qF '.slice(userInputEntryCount)' "$interactive" ||
         ! grep -qF 'Pending submission: ''${this.pendingPromptAdmission}' "$interactive"; then
        echo "failed prompt input restoration or pending-state visibility missing" >&2
        exit 1
      fi
      if grep -qF 'const reloadBox = new Container();' "$interactive" ||
         grep -qF 'this.ui.setFocus(reloadBox);' "$interactive" ||
         ! grep -qF 'this.showStatus("Reloading keybindings, extensions, skills, prompts, themes, and context files...");' "$interactive" ||
         ! grep -qF 'this.ui.setFocus(this.editor);' "$interactive"; then
        echo "reload replaced or unfocused the interactive editor" >&2
        exit 1
      fi
      if ! grep -qF 'event.message.errorMessage = "Cancelled by user";' "$session" ||
         ! grep -qF 'void this.session.abort("user");' "$interactive" ||
         ! grep -qF 'abortMessage === "Cancelled by user"' "$assistant_message"; then
        echo "typed user-interruption rendering missing" >&2
        exit 1
      fi
      grep -qF 'typeof runner === "function"' "$wrapper"
      grep -qF 'activeRunner.createContext()' "$wrapper"
      grep -qF '() => this._extensionRunner' "$session"
      grep -qF 'const DEFAULT_CANVAS_BACKGROUND = "#080B1A";' "$canvas"
      grep -qF 'applyTuiCanvasBackground(line, width)' "$alt_screen"
      grep -qF 'applyTuiCanvasBackground(line, width)' "$main_screen"
      if ! grep -qF 'raceWithAbortSignal(oauth.refresh(current, refreshSignal), refreshSignal)' "$oauth_resolver" ||
         ! grep -qF '}, { signal: refreshSignal });' "$oauth_resolver"; then
        echo "OAuth refresh abort enforcement missing" >&2
        exit 1
      fi
      if ! test -f "$request_lifecycle" ||
         ! test -L "$request_lifecycle_bridge" ||
         ! test -f "$request_lifecycle_bridge" ||
         ! grep -qF 'withRequestLifecycle(model' "$model_runtime" ||
         ! grep -qF 'RequestLifecyclePhase.AuthLockWait' "$auth_storage" ||
         ! grep -qF 'RequestLifecyclePhase.OAuthRefreshStarted' "$oauth_resolver" ||
         ! grep -qF 'RequestLifecyclePhase.AdmissionStarted' "$codex_provider" ||
         ! grep -qF 'RequestLifecyclePhase.TransportStarted' "$codex_provider" ||
         ! grep -qF 'RequestLifecyclePhase.RequestFailed' "$codex_provider"; then
        echo "Pi request lifecycle observability missing" >&2
        exit 1
      fi
      if grep -qF 'while (await this._handlePostAgentRun())' "$session"; then
        echo "half-applied Pi host patch: boolean continuation loop survived" >&2
        exit 1
      fi
      if find "$out/lib/node_modules/pi-monorepo" -name '*.rej' | grep -q .; then
        echo "Pi host patch left reject files" >&2
        exit 1
      fi
    '';
  });
  nuConfigDir =
    if isDarwin && !config.xdg.enable then
      "Library/Application Support/nushell"
    else
      "${config.xdg.configHome}/nushell";

  darwinFiles = {
    ".config/nushell/config.nu".source =
      config.lib.file.mkOutOfStoreSymlink "${config.home.homeDirectory}/Library/Application Support/nushell/config.nu";
    ".config/nushell/env.nu".source =
      config.lib.file.mkOutOfStoreSymlink "${config.home.homeDirectory}/Library/Application Support/nushell/env.nu";
    "Library/Application Support/com.mitchellh.ghostty/config.ghostty".source =
      ./ghostty/config.ghostty;
  };

  piExtensionNodeModules = pkgs.importNpmLock.buildNodeModules {
    npmRoot = ./ai/pi/extensions;
    inherit (pkgs) nodejs;
    derivationArgs.npmInstallFlags = "--legacy-peer-deps --omit=dev";
  };
  pieceOfPiWhisper =
    (pkgs.whisper-cpp.override {
      coreMLSupport = false;
      withSDL = false;
    }).overrideAttrs
      (_: {
        # nixpkgs' Darwin postPatch appends an unconditional whisper.coreml
        # install target. Keep only the example installs when CoreML is disabled.
        postPatch = ''
          for target in examples/{bench,command,cli,quantize,server,stream,talk-llama}/CMakeLists.txt; do
            if ! grep -q -F 'install(' "$target"; then
              echo 'install(TARGETS ''${TARGET} RUNTIME)' >> "$target"
            fi
          done
        '';
      });
  pieceOfPiWhisperModel = pkgs.fetchurl {
    url = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base-q5_1.bin";
    hash = "sha256-Qi8a5FKt5vMKAE1+XGpDGV5EM7w3C/I/rJzFkfAaiJg=";
  };
  piBridge = pkgs.writeShellApplication {
    name = "pi-bridge";
    runtimeInputs = [ pkgs.nodejs ];
    text = ''
      exec node --experimental-strip-types \
        "$HOME/.config/ai/pi/extensions/remote-control/bridge-cli.ts" "$@"
    '';
  };
  piControlPlane = pkgs.writeTextFile {
    name = "pi-control-plane";
    destination = "/bin/pi-control-plane";
    executable = true;
    text = ''
      #!${lib.getExe pkgs.nushell}
      let source_root = ($env.HOME | path join ".config" "ai" "pi" "extensions" "control-plane")
      let state_root = ($env.XDG_STATE_HOME? | default ($env.HOME | path join ".local" "state"))
      let dashboard_root = ($state_root | path join "pi" "control-plane" "dashboard")
      let build_root = ($state_root | path join "pi" "control-plane" $"dashboard-build-($nu.pid)")
      mkdir ($build_root | path join "dashboard")
      cp ($source_root | path join "dashboard" "app.tsx") ($build_root | path join "dashboard" "app.tsx")
      cp ($source_root | path join "dashboard" "allowance-chart.ts") ($build_root | path join "dashboard" "allowance-chart.ts")
      cp ($source_root | path join "allowance-pool.ts") ($build_root | path join "allowance-pool.ts")
      cp ($source_root | path join "job-runtime.ts") ($build_root | path join "job-runtime.ts")
      cp ($source_root | path join "job-presentation.ts") ($build_root | path join "job-presentation.ts")
      cp ($source_root | path join "usage-policy.ts") ($build_root | path join "usage-policy.ts")
      cp ($source_root | path join "harness-protocol.ts") ($build_root | path join "harness-protocol.ts")
      cp ($source_root | path join "harness-research-protocol.ts") ($build_root | path join "harness-research-protocol.ts")
      cp ($source_root | path join "review-duty-profile.ts") ($build_root | path join "review-duty-profile.ts")
      ^${pkgs.coreutils}/bin/rm --recursive --force ($build_root | path join "node_modules")
      ^${pkgs.coreutils}/bin/ln --symbolic --no-target-directory ${piExtensionNodeModules}/node_modules ($build_root | path join "node_modules")
      (
        ^${piExtensionNodeModules}/node_modules/.bin/babel ($build_root | path join "dashboard" "app.tsx")
          --out-file ($build_root | path join "dashboard" "app.js")
          --presets=${piExtensionNodeModules}/node_modules/@babel/preset-typescript,${piExtensionNodeModules}/node_modules/babel-preset-solid
      )
      mkdir $dashboard_root
      (
        ^${lib.getExe pkgs.esbuild} ($build_root | path join "dashboard" "app.js")
          --bundle
          --format=esm
          --minify
          --outfile=($dashboard_root | path join "app.js")
          --platform=browser
      )
      cp ($source_root | path join "dashboard" "index.html") ($dashboard_root | path join "index.html")
      cp ($source_root | path join "dashboard" "app.css") ($dashboard_root | path join "app.css")
      rm --recursive --force $build_root
      $env.PI_CONTROL_PLANE_DASHBOARD_DIR = $dashboard_root
      exec ${lib.getExe pkgs.nodejs} --experimental-strip-types ($source_root | path join "main.ts")
    '';
    meta.mainProgram = "pi-control-plane";
  };
  piControlPlaneWatch = pkgs.writeTextFile {
    name = "pi-control-plane-watch";
    destination = "/bin/pi-control-plane-watch";
    executable = true;
    text = ''
      #!${lib.getExe pkgs.nushell}
      let source_root = ($env.HOME | path join ".config" "ai" "pi" "extensions" "control-plane")
      exec ${lib.getExe pkgs.watchexec} --restart --exit-on-error --shell=none --watch $source_root -- ${piControlPlane}/bin/pi-control-plane
    '';
    meta.mainProgram = "pi-control-plane-watch";
  };
  piHarnessWorker = pkgs.writeShellApplication {
    name = "pi-harness-worker";
    runtimeInputs = [ pkgs.nodejs ];
    text = ''
      export PI_HARNESS_ALLOWED_ROOTS="''${PI_HARNESS_ALLOWED_ROOTS:-$HOME/code/st0x:$HOME/code/dataclique:$HOME/code/0xgleb:$HOME/.config}"
      exec node "$HOME/.config/ai/pi/extensions/control-plane/harness-worker-main.ts" "$@"
    '';
  };
  pieceOfPiTelegram = pkgs.writeShellApplication {
    name = "piece-of-pi-telegram";
    runtimeInputs = [
      pkgs.nodejs
      pieceOfPiWhisper
    ];
    text = ''
      exec node --experimental-strip-types \
        "$HOME/.config/ai/pi/extensions/remote-control/piece-of-pi.ts" "$@"
    '';
  };

in
{
  home = {
    username = "0xgleb";
    stateVersion = "24.05";

    packages =
      let
        # Track Anthropic's prebuilt Claude Code binary ahead of nixpkgs by
        # pinning the release manifest as a flake input. The binary checksums
        # live in the manifest (verified by fetchurl); the manifest itself is
        # pinned in flake.lock. Bump via the claude-code-manifest input.
        claude-code-latest =
          let
            manifest = builtins.fromJSON (builtins.readFile inputs.claude-code-manifest);
            key = "${pkgs.stdenv.hostPlatform.node.platform}-${pkgs.stdenv.hostPlatform.node.arch}";
          in
          unstable.claude-code.overrideAttrs (_: {
            version = manifest.version;
            src = pkgs.fetchurl {
              url = "https://downloads.claude.ai/claude-code-releases/${manifest.version}/${key}/claude";
              sha256 = manifest.platforms.${key}.checksum;
            };
          });

        piSolReview = pkgs.writeShellApplication {
          name = "pi-sol-review";
          runtimeInputs = [ pi-coding-agent-with-reload ];
          text = ''
            if [ "$#" -gt 0 ]; then
              prompt="$*"
            else
              prompt="$(cat)"
            fi
            if [[ ! "$prompt" =~ [^[:space:]] ]]; then
              echo "usage: pi-sol-review <focused read-only review task>" >&2
              exit 2
            fi
            exec env -u PI_INTERNAL_WORKFLOW_CHILD_TOKEN_LIMIT pi \
              --print \
              --no-session \
              --no-extensions \
              --extension "$HOME/.config/ai/pi/extensions/classified-workflows/index.ts" \
              --no-skills \
              --no-prompt-templates \
              --tools read,grep,find,ls \
              --model openai-codex/gpt-5.6-sol \
              --thinking high \
              "$prompt"
          '';
        };
      in
      (with unstable; [
        codex
        graphite-cli
      ])
      ++ [
        pkgs.ragenix
        pkgs.age
        but
        claude-code-latest
        jf
        pieceOfPiTelegram
        piBridge
        piControlPlane
        piControlPlaneWatch
        piHarnessWorker
        piSolReview
        pi-coding-agent-with-reload
        pkgs.prek
        pkgs.prettier
      ];

    shell.enableNushellIntegration = true;
    sessionPath = lib.mkIf isDarwin [
      "$HOME/.pi/agent/bin"
      "$HOME/.nix-profile/bin"
      "/run/current-system/sw/bin"
      "/etc/profiles/per-user/${config.home.username}/bin"
      "/nix/var/nix/profiles/default/bin"
      "/opt/homebrew/bin"
      "/usr/local/bin"
    ];
    file = {
      "${nuConfigDir}/fj".source = ./nushell/fj;
      ".agents/skills".source = config.lib.file.mkOutOfStoreSymlink "${aiDir}/skills";
      ".claude/skills".source = config.lib.file.mkOutOfStoreSymlink "${aiDir}/skills";
      ".cursor/skills".source = config.lib.file.mkOutOfStoreSymlink "${aiDir}/skills";
      ".cursor/hooks".source = config.lib.file.mkOutOfStoreSymlink "${aiDir}/cursor/hooks";
      ".cursor/hooks.json".source = config.lib.file.mkOutOfStoreSymlink "${aiDir}/cursor/hooks.json";
      ".cursor/agent-env.sh".source = config.lib.file.mkOutOfStoreSymlink "${aiDir}/cursor/agent-env.sh";
      ".cursor/AGENTS.md".source = config.lib.file.mkOutOfStoreSymlink "${aiDir}/AGENTS.md";
      ".cursor/CLAUDE.md".source = config.lib.file.mkOutOfStoreSymlink "${aiDir}/AGENTS.md";
      ".pi/agent/AGENTS.md".source = config.lib.file.mkOutOfStoreSymlink "${aiDir}/pi/AGENTS.md";
      ".pi/agent/bin/but".source = "${but}/bin/but";
      ".pi/agent/bin/but".force = true;
      ".pi/agent/bin/pi".source = "${pi-coding-agent-with-reload}/bin/pi";
      ".pi/agent/bin/pi".force = true;
      ".pi/agent/bin/pi-control-plane".source = "${piControlPlane}/bin/pi-control-plane";
      ".pi/agent/bin/pi-control-plane".force = true;
      ".pi/agent/bin/pi-control-plane-watch".source = "${piControlPlaneWatch}/bin/pi-control-plane-watch";
      ".pi/agent/bin/pi-control-plane-watch".force = true;
      ".pi/agent/models.json".text = builtins.toJSON {
        providers."openai-codex".modelOverrides = {
          "gpt-5.6-sol".maxTokens = 32000;
          "gpt-5.6-terra".maxTokens = 16000;
          "gpt-5.6-luna".maxTokens = 16000;
        };
      };
      ".pi/agent/skills".source = config.lib.file.mkOutOfStoreSymlink "${aiDir}/skills";
      ".local/share/nvim/site/parser/move.so".source = "${moveTreeSitter}/parser/move.so";
      ".local/share/nvim/site/queries/move".source = "${moveTreeSitter}/queries/move";
      ".config/ai/pi/extensions/node_modules" = {
        source = "${piExtensionNodeModules}/node_modules";
        force = true;
      };
    }
    // lib.optionalAttrs isDarwin darwinFiles;

    activation = {
      nvimLazyRestore = lib.hm.dag.entryAfter [ "writeBoundary" ] ''
        export PATH=${lib.makeBinPath [ pkgs.git ]}:$PATH
        $DRY_RUN_CMD ${config.programs.neovim.finalPackage}/bin/nvim \
          --headless "+Lazy! restore" +qa 2>/dev/null || true
      '';

      mergeCursorCliConfig = lib.hm.dag.entryAfter [ "writeBoundary" ] ''
        cursor_config="${cursorDir}/cli-config.json"
        cursor_settings="${aiDir}/cursor.settings.json"
        if [ ! -f "$cursor_settings" ]; then
          exit 0
        fi
        if [ -f "$cursor_config" ]; then
          $DRY_RUN_CMD ${pkgs.jq}/bin/jq -s '.[0] * .[1]' "$cursor_config" "$cursor_settings" > "$cursor_config.tmp"
        else
          $DRY_RUN_CMD ${pkgs.jq}/bin/jq '. + {"version": 1}' "$cursor_settings" > "$cursor_config.tmp"
        fi
        $DRY_RUN_CMD mv "$cursor_config.tmp" "$cursor_config"
      '';

      mergePiConfig = lib.hm.dag.entryAfter [ "writeBoundary" ] ''
        pi_settings="${piDir}/settings.json"
        managed_settings="${aiDir}/pi.settings.json"
        $DRY_RUN_CMD ${pkgs.coreutils}/bin/mkdir -p "${piDir}"
        if [ -f "$pi_settings" ]; then
          $DRY_RUN_CMD ${pkgs.jq}/bin/jq -s '.[0] * .[1]' "$pi_settings" "$managed_settings" > "$pi_settings.tmp"
        else
          $DRY_RUN_CMD ${pkgs.jq}/bin/jq '.' "$managed_settings" > "$pi_settings.tmp"
        fi
        $DRY_RUN_CMD mv "$pi_settings.tmp" "$pi_settings"
      '';

      patchPiHermesMemory = lib.hm.dag.entryAfter [ "mergePiConfig" ] ''
        package_root="${piDir}/npm/node_modules/pi-hermes-memory"
        package_manifest="$package_root/package.json"
        live_patch="${aiDir}/pi/patches/pi-hermes-memory-bounded-live-index.patch"
        backfill_patch="${aiDir}/pi/patches/pi-hermes-memory-bounded-session-backfill.patch"
        indexer_source="$package_root/src/store/session-indexer.ts"
        parser_source="$package_root/src/store/session-parser.ts"

        if [ ! -f "$indexer_source" ] || [ ! -f "$parser_source" ]; then
          exit 0
        fi
        if ${pkgs.gnugrep}/bin/grep -q 'MAX_LIVE_SESSION_ENTRIES' "$indexer_source" \
          && ${pkgs.gnugrep}/bin/grep -q 'MAX_SESSION_TAIL_READ_BYTES' "$parser_source"; then
          exit 0
        fi
        package_version="$(${pkgs.jq}/bin/jq -r '.version // empty' "$package_manifest")"
        if [ "$package_version" != "0.8.1" ]; then
          echo "Refusing to patch unsupported pi-hermes-memory $package_version" >&2
          exit 1
        fi
        if ! ${pkgs.gnugrep}/bin/grep -q 'MAX_LIVE_SESSION_ENTRIES' "$indexer_source"; then
          $DRY_RUN_CMD ${pkgs.patch}/bin/patch --batch --forward --directory="$package_root" --strip=1 < "$live_patch"
        fi
        if ! ${pkgs.gnugrep}/bin/grep -q 'MAX_SESSION_TAIL_READ_BYTES' "$parser_source"; then
          $DRY_RUN_CMD ${pkgs.patch}/bin/patch --batch --forward --directory="$package_root" --strip=1 < "$backfill_patch"
        fi
      '';
    };
  };

  launchd.agents.pieceOfPiTelegram =
    lib.mkIf (isDarwin && builtins.pathExists ./secrets/metagenda-telegram-token.age)
      {
        enable = true;
        config = {
          ProgramArguments = [ "${pieceOfPiTelegram}/bin/piece-of-pi-telegram" ];
          EnvironmentVariables = {
            PIECE_OF_PI_TELEGRAM_OWNER_USERNAME = "dianov";
            PIECE_OF_PI_TELEGRAM_TOKEN_FILE = "/run/agenix/metagenda-telegram-token";
            PIECE_OF_PI_WHISPER_MODEL = "${pieceOfPiWhisperModel}";
          };
          KeepAlive = true;
          ProcessType = "Background";
          RunAtLoad = true;
          StandardErrorPath = "/tmp/piece-of-pi-telegram.err";
          StandardOutPath = "/tmp/piece-of-pi-telegram.out";
          ThrottleInterval = 5;
        };
      };

  # NOTE: this shit doesn't clean up after itself if you enable/disable it
  # services.ollama.enable = false;

  programs = {
    home-manager.enable = true;

    zellij.enable = true;
    nushell = {
      enable = true;
      envFile.source = ./nushell/env.src.nu;
      configFile.source = ./nushell/config.src.nu;
      # configDir = nuDir;

      # plugins = with pkgs.nushellPlugins; [
      #   polars
      #   query
      # ];
    };

    git = {
      enable = true;
      signing.format = "openpgp";
      settings = {
        user.name = "0xgleb";
        init.defaultBranch = "master";
        push.autoSetupRemote = true;
      };
    };

    difftastic = {
      enable = true;
      git.enable = true;
      git.mode = "both";
    };

    neovim = {
      enable = true;
      withRuby = false;
      withPython3 = false;
      extraPackages = with pkgs; [
        fd
        gcc
        lazygit
        lua-language-server
        luarocks
        moveAnalyzer
        nil
        ripgrep
        rust-analyzer
        svelte-language-server
        typescript-language-server
      ];
      plugins = with pkgs.vimPlugins; [
        (nvim-treesitter.withPlugins (grammars: [
          grammars.bash
          grammars.html
          grammars.css
          grammars.javascript
          grammars.json
          grammars.lua
          grammars.markdown
          grammars.markdown_inline
          grammars.nix
          grammars.rust
          grammars.svelte
          grammars.toml
          grammars.typescript
          grammars.yaml
        ]))
      ];
      initLua = builtins.readFile ./nvim/bootstrap.lua;
    };

    # Atuin — fuzzy history search (ctrl+r) for nushell
    # TODO: replace with a better one
    atuin.enable = true;
    atuin.enableNushellIntegration = true;

    # Carapace — completions for git, docker, gh, and hundreds more
    carapace.enable = true;
    carapace.enableNushellIntegration = true;

    # Zoxide — smart directory jumping
    zoxide.enable = true;
    zoxide.enableNushellIntegration = true;
    zoxide.enableZshIntegration = true;

    # Direnv
    direnv.enable = true;
    direnv.nix-direnv.enable = true;
    direnv.config.global.hide_env_diff = true;

    # fzf.enable = true;
    # fzf.enableZshIntegration = true;

    # Doom Emacs (managed by nix-doom-emacs-unstraightened)
    doom-emacs = {
      enable = false; # isDarwin;
      doomDir = ./doom;
      emacs = if isDarwin then pkgs.emacs-macport else pkgs.emacs;
    };

    zsh =
      let
        zshCustom = pkgs.stdenv.mkDerivation {
          name = "zsh-custom";
          src = ./.;
          installPhase = ''
            mkdir -p $out/themes
            cp ./hyperzsh.zsh-theme $out/themes/
          '';
        };

      in
      {
        enable = true;
        oh-my-zsh = {
          enable = true;
          custom = "${zshCustom}";
          theme = "hyperzsh";
          plugins = [ "autojump" ];
        };

        dotDir = "${config.xdg.configHome}/.zsh";

        initContent = ''
          PROMPT='%{$fg[cyan]%}%c %{$reset_color%}➜ '
          export PATH="$PATH:/opt/homebrew/bin"
          set -o vi
          fastfetch
          eval "$(gt completion --shell zsh)"
        '';
      };
  };
}
