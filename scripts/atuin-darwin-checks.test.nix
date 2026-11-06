{
  pkgs,
  nushellCheck,
}:
let
  package = pkgs.atuin;
in
assert pkgs.stdenv.hostPlatform.system == "aarch64-darwin";
assert package.version == "18.24.4";
assert package.src.outputHash == "sha256-7dBilDd1mb9NhcozN6vIAiVqmRJiJgvdmA0bZJWDVT0=";
assert builtins.any (input: input.drvPath == package.drvPath) nushellCheck.nativeBuildInputs;
true
