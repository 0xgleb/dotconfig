{ pkgs, metagendaFj }:
let
  sentinelFj = pkgs.writeShellScriptBin "fj" ''
    printf '%s\n' 'metagenda-consumer-sentinel'
  '';
  jf = import ./jf.nix {
    inherit pkgs;
    metagendaFj = sentinelFj;
  };
  fixtureGh = pkgs.writeShellScriptBin "gh" ''
    printf '%s\n' '{"number":42,"title":"Synthetic issue","body":"Fixture body","author":null,"state":"OPEN","labels":[],"createdAt":"2026-09-19T00:00:00Z"}'
  '';
  realJf = import ./jf.nix {
    inherit pkgs;
    metagendaFj = metagendaFj.override { gh = fixtureGh; };
  };
in
pkgs.runCommand "jf-consumer-test"
  {
    nativeBuildInputs = with pkgs; [
      git
      nushell
    ];
  }
  ''
    mkdir home repository
    export HOME="$PWD/home"
    git init --initial-branch=feature repository
    cd repository
    echo "checking the packaged consumer uses its exact supplied dependency"
    actual=$(${jf}/bin/jf issue list)
    printf '%s\n' "$actual"
    test "$actual" = 'metagenda-consumer-sentinel'
    module_actual=$(nu --no-config-file --no-history --commands 'use ${jf.fjLib}/fj; fj issue list')
    test "$module_actual" = 'metagenda-consumer-sentinel'
    ${jf}/bin/jf help > ../local-help
    grep -F clanker ../local-help
    nu --no-config-file --no-history ${./fj}/consumer.test.nu "$TMPDIR"
    git checkout -b gitbutler/workspace
    if command -v but; then
      echo "test fixture unexpectedly exposes But" >&2
      exit 1
    fi
    echo "checking the real package consumer preserves standalone status without But"
    ${realJf}/bin/jf > ../managed-status
    cat ../managed-status
    grep -F 'On branch gitbutler/workspace' ../managed-status
    echo "checking actual portable formatting without network or runtime warnings"
    ${realJf}/bin/jf issue view 42 > ../issue-view 2> ../issue-errors
    cat ../issue-view ../issue-errors
    grep -F '# Synthetic issue' ../issue-view
    test ! -s ../issue-errors
    touch "$out"
  ''
