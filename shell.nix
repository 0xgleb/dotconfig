{
  pkgs ?
    let
      flake = builtins.getFlake ("git+file://" + toString ./.);
    in
    import flake.inputs.nixpkgs { system = builtins.currentSystem; },
}:
pkgs.mkShellNoCC {
  packages = [
    pkgs.nodejs
    pkgs.prek
    pkgs.prettier
  ];

  shellHook = ''
    prek install
  '';
}
