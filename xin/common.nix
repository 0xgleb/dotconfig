{
  pkgs,
  inputs,
  ...
}:
let
  unstable = import inputs.nixpkgs-unstable {
    system = pkgs.stdenv.hostPlatform.system;
    config.allowUnfree = true;
  };
in
{
  nixpkgs.config.allowUnfree = true;

  environment = {
    shells = [ pkgs.nushell ];

    systemPackages = with pkgs; [
      git
      ripgrep
      fd
      nil
      nixd
      nixfmt
      unstable.graphite-cli
      unstable.claude-code
    ];
  };

  nix.settings = {
    experimental-features = "nix-command flakes";
    trusted-users = [ "0xgleb" ];
    substituters = [ "https://cache.nixos.org" ];
    trusted-public-keys = [ "cache.nixos.org-1:6NCHdD59X431o0gWypbMrAURkbJ16ZPMQFGspcDShjY=" ];
  };
}
