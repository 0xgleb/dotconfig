let
  flake = builtins.getFlake ("git+file://" + toString ./.);
in
flake.devShells.${builtins.currentSystem}.default
