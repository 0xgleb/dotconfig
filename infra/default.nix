{ pkgs }:
let
  inherit (pkgs) lib;

  writeNushellApplication =
    {
      name,
      text,
      runtimeInputs ? [ ],
    }:
    let
      script = pkgs.writeTextFile {
        inherit name;
        executable = true;
        destination = "/bin/${name}";
        text = "#!${pkgs.nushell}/bin/nu\n${text}";
      };
    in
    if runtimeInputs == [ ] then
      script
    else
      pkgs.symlinkJoin {
        inherit name;
        paths = [ script ];
        nativeBuildInputs = [ pkgs.makeWrapper ];
        postBuild = ''
          wrapProgram $out/bin/${name} \
            --prefix PATH : ${lib.makeBinPath runtimeInputs}
        '';
      };

  infraInputs = [
    pkgs.terraform
    pkgs.rage
  ];

  # Shared nushell helpers (with-infra, resolve-identity, infra-recipients).
  # Concatenated ahead of each command so the helpers are in scope at runtime.
  infraLib = builtins.readFile ./scripts/lib.nu;

  withLib =
    file:
    lib.concatStringsSep "\n" [
      infraLib
      (builtins.readFile file)
    ];
in
{
  tfPlan = writeNushellApplication {
    name = "tf-plan";
    runtimeInputs = infraInputs;
    text = withLib ./scripts/tf-plan.nu;
  };

  tfVars = writeNushellApplication {
    name = "tf-vars";
    runtimeInputs = infraInputs;
    text = withLib ./scripts/tf-vars.nu;
  };

  provision = writeNushellApplication {
    name = "provision";
    runtimeInputs = infraInputs ++ [
      pkgs.openssh
      pkgs.coreutils
    ];
    text = withLib ./scripts/provision.nu;
  };
}
