{ pkgs }:
let
  inherit (pkgs) lib;

  fjLib = pkgs.stdenv.mkDerivation {
    name = "fj-nushell-lib";
    src = builtins.path {
      path = ./scripts/fj;
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

  wrapper = pkgs.writeShellScriptBin "jf" ''
    exec ${pkgs.nushell}/bin/nu --no-config-file ${entrypoint} -- "$@"
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
