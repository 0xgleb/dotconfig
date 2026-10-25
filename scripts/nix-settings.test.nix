let
  settings = (import ../common.nix { pkgs = { }; }).nix.settings;
in
assert builtins.isList settings.experimental-features;
assert
  settings.experimental-features == [
    "nix-command"
    "flakes"
  ];

true
