{
  lib,
  stdenvNoCC,
  nushell,
  git,
  gh,
  makeWrapper,
}:

stdenvNoCC.mkDerivation {
  pname = "fj";
  version = "0.1.0";
  src = lib.fileset.toSource {
    root = ./.;
    fileset = lib.fileset.unions [
      ./mod.nu
      ./routing.nu
      ./gh.nu
      ./help.nu
      ./completions.nu
      ./cli.nu
      ./tests
      ./LICENSE
    ];
  };
  nativeBuildInputs = [
    nushell
    git
    makeWrapper
  ];
  doCheck = true;
  checkPhase = ''
    runHook preCheck
    nu --no-config-file --no-history tests/run.nu "$TMPDIR"
    runHook postCheck
  '';
  installPhase = ''
    runHook preInstall
    mkdir -p "$out/share/nushell/fj" "$out/share/licenses/fj" "$out/bin"
    cp mod.nu routing.nu gh.nu help.nu completions.nu cli.nu "$out/share/nushell/fj/"
    cp LICENSE "$out/share/licenses/fj/LICENSE"
    makeWrapper ${lib.getExe nushell} "$out/bin/fj" \
      --add-flags "--no-config-file --no-history $out/share/nushell/fj/cli.nu" \
      --prefix PATH : ${
        lib.makeBinPath [
          git
          gh
        ]
      }
    runHook postInstall
  '';
  meta = {
    description = "Portable repository and GitHub inspection CLI";
    license = lib.licenses.mit;
    mainProgram = "fj";
    platforms = lib.platforms.unix;
  };
}
