{ pkgs }:
let
  package = pkgs.typescript-language-server;
  # Recorded by the real aarch64-darwin fetch, including the isolated reproduction.
  darwinDependencyHash = "sha256-PmyJb8090pEPc09Tbv8RgdvQpzpba2L8ve87+aVncQU=";
in
# A future package version needs its own fetch verification, not the 6.0.2 override.
assert package.version == "6.0.2";
assert package.pnpmDeps.outputHash == darwinDependencyHash;
true
