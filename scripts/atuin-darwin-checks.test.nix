{
  pkgs,
  upstreamAtuin,
  nushellCheck,
}:
let
  package = pkgs.atuin;
  excludedTests = [
    "--skip=filtered_commands_leave_no_captured_output"
  ];
in
assert pkgs.stdenv.hostPlatform.isDarwin;
assert package.doCheck;
assert builtins.all (flag: builtins.elem flag package.checkFlags) excludedTests;
assert
  builtins.filter (flag: !(builtins.elem flag excludedTests)) package.checkFlags
  == upstreamAtuin.checkFlags;
assert package.src.outPath == upstreamAtuin.src.outPath;
assert builtins.any (input: input.drvPath == package.drvPath) nushellCheck.nativeBuildInputs;
true
