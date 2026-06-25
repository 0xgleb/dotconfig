{ pkgs, inputs }:
let
  inherit (pkgs) lib;

  nixos-anywhere = inputs.nixos-anywhere.packages.${pkgs.system}.default;

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
  infraLib = builtins.readFile ./lib.nu;

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
    text = withLib ./tf-plan.nu;
  };

  tfApply = writeNushellApplication {
    name = "tf-apply";
    runtimeInputs = infraInputs;
    text = withLib ./tf-apply.nu;
  };

  tfDestroy = writeNushellApplication {
    name = "tf-destroy";
    runtimeInputs = infraInputs;
    text = withLib ./tf-destroy.nu;
  };

  tfVars = writeNushellApplication {
    name = "tf-vars";
    runtimeInputs = infraInputs;
    text = withLib ./tf-vars.nu;
  };

  provision = writeNushellApplication {
    name = "provision";
    runtimeInputs = infraInputs ++ [
      pkgs.openssh
      pkgs.coreutils
      nixos-anywhere
    ];
    text = withLib ./provision.nu;
  };
}
