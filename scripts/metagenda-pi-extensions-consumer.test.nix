let
  directories = [
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
  personalDirectories = [
    "browser-control"
    "local-models"
    "pi-vim"
    "todo"
  ];
  checkPlatform =
    system: isDarwin:
    let
      package = "/test/metagenda-pi-source-${system}";
      module = import ../home.nix {
        pkgs.stdenv.hostPlatform = { inherit system isDarwin; };
        lib.optionalAttrs = condition: attrs: if condition then attrs else { };
        inputs.metagenda.packages.${system} = {
          pi-skills = "/test/metagenda-skills-${system}";
          pi-source = package;
        };
        config = {
          home.homeDirectory = "/test/home";
          xdg.enable = false;
          xdg.configHome = "/test/home/.config";
        };
      };
      mappedCorrectly = builtins.all (
        directory:
        module.home.file.".config/ai/pi/extensions/${directory}".source
        == "${package}/extensions/${directory}"
      ) directories;
      personalStaysLocal = builtins.all (
        directory: !builtins.hasAttr ".config/ai/pi/extensions/${directory}" module.home.file
      ) personalDirectories;
    in
    mappedCorrectly && personalStaysLocal;
in
assert checkPlatform "aarch64-darwin" true;
assert checkPlatform "x86_64-linux" false;
true
