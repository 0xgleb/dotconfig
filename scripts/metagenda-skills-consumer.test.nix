let
  paths = [
    ".agents/skills"
    ".claude/skills"
    ".cursor/skills"
    ".pi/agent/skills"
  ];
  checkPlatform =
    system: isDarwin:
    let
      package = "/test/metagenda-${system}";
      module = import ../home.nix {
        pkgs.stdenv.hostPlatform = { inherit system isDarwin; };
        lib.optionalAttrs = condition: attrs: if condition then attrs else { };
        inputs.metagenda.packages.${system}.pi-skills = package;
        config = {
          home.homeDirectory = "/test/home";
          xdg.enable = false;
          xdg.configHome = "/test/home/.config";
        };
      };
    in
    builtins.all (
      path: module.home.file.${path}.source == "${package}/share/metagenda/pi-skills/skills"
    ) paths;
in
assert checkPlatform "aarch64-darwin" true;
assert checkPlatform "x86_64-linux" false;
true
