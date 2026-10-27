let
  flake = builtins.getFlake ("git+file://" + toString ./.);
in
{
  pkgs ? flake.inputs.nixpkgs.legacyPackages.${builtins.currentSystem},
}:
flake.devShells.${pkgs.stdenv.hostPlatform.system}.default
