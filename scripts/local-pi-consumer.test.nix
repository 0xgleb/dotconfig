let
  checkPlatform =
    system: isDarwin:
    let
      module = import ../home.nix {
        pkgs.stdenv.hostPlatform = { inherit system isDarwin; };
        lib.optionalAttrs = condition: attrs: if condition then attrs else { };
        inputs = { };
        config = {
          home.homeDirectory = "/fixture/home";
          xdg.enable = false;
          xdg.configHome = "/fixture/home/.config";
          lib.file.mkOutOfStoreSymlink = path: path;
        };
      };
      unmanaged =
        builtins.all (name: !builtins.hasAttr ".config/ai/pi/extensions/${name}" module.home.file)
          [
            "activity-status"
            "agent-registry"
            "agent-workspace"
            "auto-reload"
            "btw"
            "classified-workflows"
            "compact-footer"
            "compact-read"
            "control-plane"
            "disk-pressure"
            "image-summary"
            "input-ergonomics"
            "lsp"
            "nushell-default"
            "questions"
            "release-cadence"
            "remote-control"
            "request-observability"
            "safe-compaction"
            "shared"
            "usage-governor"
            "write-result-inspector"
          ];
      skills = builtins.all (path: module.home.file.${path}.source == "/fixture/home/.config/ai/skills") [
        ".agents/skills"
        ".claude/skills"
        ".cursor/skills"
        ".pi/agent/skills"
      ];
    in
    unmanaged && skills;
in
assert !(builtins.hasAttr "metagenda" (import ../flake.nix).inputs);
assert checkPlatform "aarch64-darwin" true;
assert checkPlatform "x86_64-linux" false;
true
