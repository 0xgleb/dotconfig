{ pkgs }:
let
  inherit (pkgs) lib;

  fjLib = pkgs.stdenv.mkDerivation {
    name = "fj-nushell-lib";
    src = builtins.path {
      path = ./fj;
      name = "fj-src";
    };
    phases = [ "installPhase" ];
    installPhase = ''
      mkdir -p $out/fj
      cp -r $src/* $out/fj/
      chmod -R u+w $out
      find $out -name '*.test.nu' -delete
    '';
  };

  entrypoint = pkgs.replaceVars ./jf-entrypoint.nu { inherit fjLib; };

  runtimeDeps = with pkgs; [
    git
    gh
    graphite-cli
    gitui
  ];

  # No `--` before "$@": nushell passes it through as a literal arg rather than
  # consuming it (so `jf status` became `fj -- status` -> "unknown command --"),
  # and nu does not intercept --help/-h after the script path, so dropping it
  # makes `jf --help` / `jf -h` reach fj's own help.
  wrapper = pkgs.writeShellScriptBin "jf" ''
    exec ${pkgs.nushell}/bin/nu --no-config-file ${entrypoint} "$@"
  '';
in
pkgs.symlinkJoin {
  name = "jf";
  paths = [ wrapper ];
  nativeBuildInputs = [ pkgs.makeWrapper ];
  postBuild = ''
    wrapProgram $out/bin/jf \
      --prefix PATH : ${lib.makeBinPath runtimeDeps}
  '';
}
