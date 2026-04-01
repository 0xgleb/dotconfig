{ pkgs, aiUserConfig, ... }:

{
  imports = [ ./shared.nix ];

  home = {
    username = aiUserConfig.name;
    homeDirectory = aiUserConfig.home;
    stateVersion = "24.05";
  };

  programs.nushell.enable = true;
}
