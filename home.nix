{
  pkgs,
  lib,
  inputs,
  config,
  ...
}:

let
  jf = import ./nushell/jf.nix { inherit pkgs; };
  isDarwin = pkgs.stdenv.isDarwin;
  aiDir = "${config.home.homeDirectory}/.config/ai";
  cursorDir = "${config.home.homeDirectory}/.cursor";
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

  # `ai/skills` is the single source of truth, authored in Claude's native
  # SKILL.md frontmatter (name, description, user-invocable, allowed-tools,
  # argument-hint). Claude and Cursor consume it live via out-of-store symlinks.
  # Codex reads a stricter frontmatter: it rejects `<`/`>` in the description and
  # ignores Claude-only keys, so `codexSkills` rewrites each SKILL.md to drop
  # `user-invocable`/`argument-hint` and turn `->` into `to`, leaving the body and
  # `allowed-tools` (which Codex also honours) untouched.
  skillNames = builtins.attrNames (
    lib.filterAttrs (_: type: type == "directory") (builtins.readDir ./ai/skills)
  );

  codexSkills = pkgs.runCommandLocal "codex-skills" { } ''
    export HOME=$(mktemp -d)
    mkdir -p "$out"
    cp -R ${./ai/skills}/. "$out/"
    chmod -R u+w "$out"
    ${pkgs.nushell}/bin/nu --no-config-file ${./ai/codex-skills.nu} "$out"
  '';

  # Codex owns `~/.codex/skills/.system`, so link each skill individually rather
  # than replacing the whole directory.
  codexSkillFiles = lib.listToAttrs (
    map (name: {
      name = ".codex/skills/${name}";
      value.source = "${codexSkills}/${name}";
    }) skillNames
  );

in
{
  home = {
    username = "0xgleb";
    stateVersion = "24.05";

    packages =
      let
        system = pkgs.stdenv.hostPlatform.system;

        unstable = import inputs.nixpkgs-unstable {
          inherit system;
          config.allowUnfree = true;
        };

        but = inputs.but-nix.packages.${system}.gitbutler-cli;

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
      in
      (with pkgs; [
        cargo-watch
        but
        jf
      ])
      ++ [ claude-code-latest ]
      ++ (with unstable; [
        codex
        graphite-cli
        cursor-cli
        antigravity-cli
      ]);

    shell.enableNushellIntegration = true;
    sessionPath = lib.mkIf isDarwin [
      "$HOME/.nix-profile/bin"
      "/run/current-system/sw/bin"
      "/etc/profiles/per-user/${config.home.username}/bin"
      "/nix/var/nix/profiles/default/bin"
      "/opt/homebrew/bin"
      "/usr/local/bin"
    ];
    file = {
      "${nuConfigDir}/fj".source = ./nushell/fj;
      ".cursor/skills".source = config.lib.file.mkOutOfStoreSymlink "${aiDir}/skills";
      ".cursor/hooks".source = config.lib.file.mkOutOfStoreSymlink "${aiDir}/cursor/hooks";
      ".cursor/hooks.json".source = config.lib.file.mkOutOfStoreSymlink "${aiDir}/cursor/hooks.json";
      ".cursor/agent-env.sh".source = config.lib.file.mkOutOfStoreSymlink "${aiDir}/cursor/agent-env.sh";
      ".cursor/AGENTS.md".source = config.lib.file.mkOutOfStoreSymlink "${aiDir}/AGENTS.md";
      ".cursor/CLAUDE.md".source = config.lib.file.mkOutOfStoreSymlink "${aiDir}/AGENTS.md";
    }
    // lib.optionalAttrs isDarwin darwinFiles
    // lib.optionalAttrs isDarwin codexSkillFiles;

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
